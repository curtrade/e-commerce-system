import { randomUUID } from 'node:crypto';
import { PgService } from '@app/common';
import { OrdersService } from './orders.service';
import { AppConfiguration } from './app.configuration';
import { InventoryClient } from './clients/inventory.client';
import { PaymentsClient } from './clients/payments.client';
import { createTestPg } from '../../../test/helpers/pg-test';
import { truncateOrders } from '../../../test/helpers/truncate';
import { CreateOrderDto } from './dto/create-order.dto';

const DTO: CreateOrderDto = {
  customerId: 'cust-1',
  email: 'buyer@example.com',
  items: [
    { sku: 'SKU-A', qty: 2, unitPrice: 7.5 },
    { sku: 'SKU-B', qty: 1, unitPrice: 4 },
  ],
};

type Inv = jest.Mocked<Pick<InventoryClient, 'reserve' | 'release'>>;
type Pay = jest.Mocked<Pick<PaymentsClient, 'charge'>>;

interface OrderRow {
  id: string;
  status: string;
  reservation_id: string | null;
  payment_id: string | null;
  total: string;
  error: string | null;
}

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  published_at: Date | null;
}

describe('OrdersService (integration)', () => {
  let pg: PgService;
  let svc: OrdersService;
  let inv: Inv;
  let pay: Pay;
  const cfg = {
    reservationTtlSec: 900,
    sagaTimeoutSec: 60,
  } as AppConfiguration;

  beforeAll(() => {
    pg = createTestPg();
  });

  afterAll(async () => {
    await pg.onApplicationShutdown();
  });

  beforeEach(async () => {
    await truncateOrders(pg);
    inv = {
      reserve: jest.fn(),
      release: jest.fn().mockResolvedValue(undefined),
    };
    pay = { charge: jest.fn() };
    svc = new OrdersService(
      pg,
      inv as unknown as InventoryClient,
      pay as unknown as PaymentsClient,
      cfg,
    );
  });

  describe('happy path', () => {
    it('persists CONFIRMED order + OrderConfirmed outbox in the same transaction', async () => {
      const reservationId = randomUUID();
      const paymentId = randomUUID();
      inv.reserve.mockResolvedValue({
        reservationId,
        expiresAt: new Date().toISOString(),
      });
      pay.charge.mockResolvedValue({ paymentId, status: 'CHARGED' });

      const res = await svc.createOrder(DTO);
      expect(res.status).toBe('CONFIRMED');

      const { rows: orderRows } = await pg.query<OrderRow>(
        'SELECT * FROM orders WHERE id = $1',
        [res.orderId],
      );
      expect(orderRows).toHaveLength(1);
      expect(orderRows[0]).toMatchObject({
        status: 'CONFIRMED',
        reservation_id: reservationId,
        payment_id: paymentId,
        total: '19.00',
        error: null,
      });

      const { rows: outboxRows } = await pg.query<OutboxRow>(
        `SELECT * FROM orders_outbox WHERE aggregate_id = $1`,
        [res.orderId],
      );
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0].event_type).toBe('OrderConfirmed');
      expect(outboxRows[0].published_at).toBeNull();
      expect(outboxRows[0].payload).toMatchObject({
        orderId: res.orderId,
        reservationId,
        paymentId,
        total: 19,
      });
    });
  });

  describe('FAILED_INVENTORY', () => {
    it('persists FAILED_INVENTORY row and OrderFailed outbox without reservationId', async () => {
      inv.reserve.mockRejectedValue(new Error('out of stock'));

      const res = await svc.createOrder(DTO);
      expect(res.status).toBe('FAILED_INVENTORY');

      const { rows: orderRows } = await pg.query<OrderRow>(
        'SELECT * FROM orders WHERE id = $1',
        [res.orderId],
      );
      expect(orderRows[0]).toMatchObject({
        status: 'FAILED_INVENTORY',
        reservation_id: null,
        payment_id: null,
        error: 'out of stock',
      });

      const { rows: outboxRows } = await pg.query<OutboxRow>(
        'SELECT * FROM orders_outbox WHERE aggregate_id = $1',
        [res.orderId],
      );
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0].event_type).toBe('OrderFailed');
      expect(outboxRows[0].payload).toEqual({
        orderId: res.orderId,
        reason: 'out of stock',
      });

      expect(inv.release).not.toHaveBeenCalled();
      expect(pay.charge).not.toHaveBeenCalled();
    });
  });

  describe('FAILED_PAYMENT', () => {
    it('calls release, persists FAILED_PAYMENT + OrderFailed outbox with reservationId', async () => {
      const reservationId = randomUUID();
      inv.reserve.mockResolvedValue({
        reservationId,
        expiresAt: new Date().toISOString(),
      });
      pay.charge.mockRejectedValue(new Error('card declined'));

      const res = await svc.createOrder(DTO);
      expect(res.status).toBe('FAILED_PAYMENT');

      expect(inv.release).toHaveBeenCalledTimes(1);
      expect(inv.release.mock.calls[0][0].reservationId).toBe(reservationId);

      const { rows: orderRows } = await pg.query<OrderRow>(
        'SELECT * FROM orders WHERE id = $1',
        [res.orderId],
      );
      expect(orderRows[0]).toMatchObject({
        status: 'FAILED_PAYMENT',
        reservation_id: reservationId,
        payment_id: null,
        error: 'card declined',
      });

      const { rows: outboxRows } = await pg.query<OutboxRow>(
        'SELECT * FROM orders_outbox WHERE aggregate_id = $1',
        [res.orderId],
      );
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0].event_type).toBe('OrderFailed');
      expect(outboxRows[0].payload).toMatchObject({
        orderId: res.orderId,
        reservationId,
        reason: 'card declined',
      });
    });
  });

  describe('CONFIRMED + outbox atomicity', () => {
    it('rolls back UPDATE if INSERT outbox fails in the same transaction', async () => {
      inv.reserve.mockResolvedValue({
        reservationId: randomUUID(),
        expiresAt: new Date().toISOString(),
      });
      pay.charge.mockResolvedValue({
        paymentId: randomUUID(),
        status: 'CHARGED',
      });

      // Force a throw between UPDATE and INSERT outbox by wrapping
      // withTransaction so the second query inside the tx callback fails.
      const realWith = pg.withTransaction.bind(pg);
      jest.spyOn(pg, 'withTransaction').mockImplementationOnce(async (fn) =>
        realWith(async (client) => {
          let n = 0;
          const realQuery = client.query.bind(client);
          (client as { query: typeof realQuery }).query = ((
            ...args: Parameters<typeof realQuery>
          ) => {
            n++;
            if (n === 2) {
              return Promise.reject(new Error('simulated outbox failure'));
            }
            return realQuery(...args);
          }) as typeof realQuery;
          return fn(client);
        }),
      );

      await expect(svc.createOrder(DTO)).rejects.toThrow(
        'simulated outbox failure',
      );

      // Order was INSERT'd as PENDING before the tx — that part is not rolled
      // back. But the UPDATE to CONFIRMED inside the tx must be.
      const { rows } = await pg.query<OrderRow>(
        `SELECT * FROM orders WHERE customer_id = $1`,
        [DTO.customerId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('PENDING');

      const { rowCount } = await pg.query('SELECT * FROM orders_outbox');
      expect(rowCount).toBe(0);
    });
  });
});
