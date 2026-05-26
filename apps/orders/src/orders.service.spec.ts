import { OrdersService } from './orders.service';
import { AppConfiguration } from './app.configuration';
import { InventoryClient } from './clients/inventory.client';
import { PaymentsClient } from './clients/payments.client';
import { createMockPg, pgResult } from '../../../test/helpers/mock-factories';
import { CreateOrderDto } from './dto/create-order.dto';

type MockInventory = jest.Mocked<Pick<InventoryClient, 'reserve' | 'release'>>;
type MockPayments = jest.Mocked<Pick<PaymentsClient, 'charge'>>;

const ITEMS = [
  { sku: 'SKU-A', qty: 2, unitPrice: 7.5 },
  { sku: 'SKU-B', qty: 1, unitPrice: 4 },
];
const DTO: CreateOrderDto = {
  customerId: 'c-1',
  email: 'buyer@example.com',
  items: ITEMS,
};

function setup() {
  const pg = createMockPg();
  const inventory: MockInventory = {
    reserve: jest.fn(),
    release: jest.fn().mockResolvedValue(undefined),
  };
  const payments: MockPayments = {
    charge: jest.fn(),
  };
  // Pick non-default values so a hardcoded 900/60 in OrdersService would
  // fail these tests instead of silently passing.
  const cfg = {
    reservationTtlSec: 12345,
    sagaTimeoutSec: 999,
  } as AppConfiguration;
  const service = new OrdersService(
    pg.service,
    inventory as unknown as InventoryClient,
    payments as unknown as PaymentsClient,
    cfg,
  );
  return { service, pg, inventory, payments, cfg };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('OrdersService.createOrder', () => {
  describe('happy path', () => {
    let s: ReturnType<typeof setup>;
    let result: Awaited<ReturnType<OrdersService['createOrder']>>;

    beforeEach(async () => {
      s = setup();
      s.inventory.reserve.mockResolvedValue({
        reservationId: 'res-1',
        expiresAt: new Date().toISOString(),
      });
      s.payments.charge.mockResolvedValue({
        paymentId: 'pay-1',
        status: 'CHARGED',
      });
      result = await s.service.createOrder(DTO);
    });

    it('inserts PENDING order with correct total', () => {
      // total = 2*7.5 + 1*4 = 19
      expect(s.pg.query).toHaveBeenCalledTimes(1);
      const [sql, params] = s.pg.query.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO orders/);
      expect(sql).toMatch(/'PENDING'/);
      const total = params![4];
      expect(total).toBe(19);
    });

    it('builds idempotency key as <orderId>:<attemptId>', () => {
      const reserveArgs = s.inventory.reserve.mock.calls[0][0];
      const chargeArgs = s.payments.charge.mock.calls[0][0];
      const [orderId, attemptId] = reserveArgs.idempotencyKey.split(':');
      expect(orderId).toMatch(UUID_RE);
      expect(attemptId).toMatch(UUID_RE);
      expect(chargeArgs.idempotencyKey).toBe(reserveArgs.idempotencyKey);
    });

    it('passes ttlSec from config to inventory.reserve', () => {
      expect(s.inventory.reserve.mock.calls[0][0].ttlSec).toBe(12345);
    });

    it('charges payment with computed total', () => {
      expect(s.payments.charge.mock.calls[0][0].amount).toBe(19);
    });

    it('does not call inventory.release on happy path', () => {
      expect(s.inventory.release).not.toHaveBeenCalled();
    });

    it('atomically updates CONFIRMED and inserts OrderConfirmed outbox event in one transaction', () => {
      expect(s.pg.withTransaction).toHaveBeenCalledTimes(1);
      expect(s.pg.txClientQuery).toHaveBeenCalledTimes(2);

      const [updateSql, updateParams] = s.pg.txClientQuery.mock.calls[0];
      expect(updateSql).toMatch(/UPDATE orders/);
      expect(updateSql).toMatch(/CONFIRMED/);
      expect(updateParams).toEqual([result.orderId, 'res-1', 'pay-1']);

      const [insertSql, insertParams] = s.pg.txClientQuery.mock.calls[1];
      expect(insertSql).toMatch(/INSERT INTO orders_outbox/);
      expect(insertParams![3]).toBe('OrderConfirmed');
      const payload = JSON.parse(insertParams![4] as string) as Record<
        string,
        unknown
      >;
      expect(payload).toMatchObject({
        orderId: result.orderId,
        reservationId: 'res-1',
        paymentId: 'pay-1',
        customerId: 'c-1',
        email: 'buyer@example.com',
        total: 19,
      });
    });

    it('returns CONFIRMED status with ids and total', () => {
      expect(result).toMatchObject({
        status: 'CONFIRMED',
        reservationId: 'res-1',
        paymentId: 'pay-1',
        total: 19,
      });
      expect(result.orderId).toMatch(UUID_RE);
    });
  });

  describe('FAILED_INVENTORY branch', () => {
    let s: ReturnType<typeof setup>;
    let result: Awaited<ReturnType<OrdersService['createOrder']>>;

    beforeEach(async () => {
      s = setup();
      s.inventory.reserve.mockRejectedValue(new Error('out of stock'));
      result = await s.service.createOrder(DTO);
    });

    it('does not call payments.charge', () => {
      expect(s.payments.charge).not.toHaveBeenCalled();
    });

    it('does not call inventory.release', () => {
      expect(s.inventory.release).not.toHaveBeenCalled();
    });

    it('writes failOrder transaction with FAILED_INVENTORY + OrderFailed event without reservationId', () => {
      expect(s.pg.withTransaction).toHaveBeenCalledTimes(1);
      const [updateSql, updateParams] = s.pg.txClientQuery.mock.calls[0];
      expect(updateSql).toMatch(/UPDATE orders/);
      expect(updateParams).toEqual([
        result.orderId,
        'FAILED_INVENTORY',
        'out of stock',
        null,
      ]);

      const [insertSql, insertParams] = s.pg.txClientQuery.mock.calls[1];
      expect(insertSql).toMatch(/INSERT INTO orders_outbox/);
      expect(insertParams![3]).toBe('OrderFailed');
      const payload = JSON.parse(insertParams![4] as string) as Record<
        string,
        unknown
      >;
      expect(payload).toEqual({
        orderId: result.orderId,
        reason: 'out of stock',
      });
      expect(payload.reservationId).toBeUndefined();
    });

    it('returns FAILED_INVENTORY with reason', () => {
      expect(result).toEqual({
        orderId: expect.stringMatching(UUID_RE) as string,
        status: 'FAILED_INVENTORY',
        reason: 'out of stock',
      });
    });
  });

  describe('FAILED_PAYMENT branch', () => {
    let s: ReturnType<typeof setup>;
    let result: Awaited<ReturnType<OrdersService['createOrder']>>;

    beforeEach(async () => {
      s = setup();
      s.inventory.reserve.mockResolvedValue({
        reservationId: 'res-1',
        expiresAt: new Date().toISOString(),
      });
      s.payments.charge.mockRejectedValue(new Error('card declined'));
      result = await s.service.createOrder(DTO);
    });

    it('calls inventory.release with <idemKey>:release suffix', () => {
      expect(s.inventory.release).toHaveBeenCalledTimes(1);
      const arg = s.inventory.release.mock.calls[0][0];
      expect(arg.reservationId).toBe('res-1');
      expect(arg.idempotencyKey).toMatch(/:release$/);

      // The base key passed to reserve/charge has no :release suffix.
      const reserveKey = s.inventory.reserve.mock.calls[0][0].idempotencyKey;
      expect(arg.idempotencyKey).toBe(`${reserveKey}:release`);
    });

    it('writes failOrder with FAILED_PAYMENT + OrderFailed including reservationId', () => {
      expect(s.pg.withTransaction).toHaveBeenCalledTimes(1);
      const updateParams = s.pg.txClientQuery.mock.calls[0][1];
      expect(updateParams).toEqual([
        result.orderId,
        'FAILED_PAYMENT',
        'card declined',
        'res-1',
      ]);

      const insertParams = s.pg.txClientQuery.mock.calls[1][1];
      expect(insertParams![3]).toBe('OrderFailed');
      const payload = JSON.parse(insertParams![4] as string) as Record<
        string,
        unknown
      >;
      expect(payload).toEqual({
        orderId: result.orderId,
        reservationId: 'res-1',
        reason: 'card declined',
      });
    });

    it('returns FAILED_PAYMENT with reason', () => {
      expect(result).toMatchObject({
        status: 'FAILED_PAYMENT',
        reason: 'card declined',
      });
    });

    // Saga relies on the InventoryClient.release contract that it never throws
    // (current production code swallows HTTP errors in a warn log, see
    // apps/orders/src/clients/inventory.client.ts:50-65). If that contract
    // changes, this test will catch it: a throw would bypass failOrder and the
    // order would stay PENDING. We document the contract by simulating the
    // worst case here.
    it('would leak PENDING if InventoryClient.release ever threw (documented contract)', async () => {
      const s2 = setup();
      s2.inventory.reserve.mockResolvedValue({
        reservationId: 'res-2',
        expiresAt: new Date().toISOString(),
      });
      s2.payments.charge.mockRejectedValue(new Error('card declined'));
      s2.inventory.release.mockRejectedValue(new Error('inventory down'));

      await expect(s2.service.createOrder(DTO)).rejects.toThrow(
        'inventory down',
      );
      // failOrder did NOT run — only the initial PENDING insert happened.
      expect(s2.pg.withTransaction).not.toHaveBeenCalled();
    });
  });
});

describe('OrdersService.recoverStuckOrders', () => {
  it('returns 0 and does not open transactions when no stuck orders', async () => {
    const s = setup();
    s.pg.query.mockResolvedValueOnce(pgResult());

    const n = await s.service.recoverStuckOrders();

    expect(n).toBe(0);
    expect(s.pg.withTransaction).not.toHaveBeenCalled();
  });

  it('selects with sagaTimeoutSec from config', async () => {
    const s = setup();
    s.pg.query.mockResolvedValueOnce(pgResult());

    await s.service.recoverStuckOrders();

    const [sql, params] = s.pg.query.mock.calls[0];
    expect(sql).toMatch(/status = 'PENDING'/);
    expect(sql).toMatch(/created_at <\s*NOW\(\)/);
    expect(params).toEqual([999]);
  });

  it('runs failOrder(FAILED_TIMEOUT) for each stuck row, preserving reservation_id', async () => {
    const s = setup();
    s.pg.query.mockResolvedValueOnce(
      pgResult([
        { id: 'order-1', reservation_id: 'res-1' },
        { id: 'order-2', reservation_id: null },
      ]),
    );

    const n = await s.service.recoverStuckOrders();

    expect(n).toBe(2);
    expect(s.pg.withTransaction).toHaveBeenCalledTimes(2);

    // First failOrder: UPDATE + INSERT outbox with reservationId.
    const firstUpdate = s.pg.txClientQuery.mock.calls[0][1];
    expect(firstUpdate).toEqual([
      'order-1',
      'FAILED_TIMEOUT',
      'saga recovery: PENDING beyond timeout',
      'res-1',
    ]);
    const firstInsert = s.pg.txClientQuery.mock.calls[1][1];
    expect(firstInsert![3]).toBe('OrderFailed');
    expect(
      JSON.parse(firstInsert![4] as string) as Record<string, unknown>,
    ).toEqual({
      orderId: 'order-1',
      reservationId: 'res-1',
      reason: 'saga recovery: PENDING beyond timeout',
    });

    // Second failOrder: no reservation_id.
    const secondInsert = s.pg.txClientQuery.mock.calls[3][1];
    const secondPayload = JSON.parse(secondInsert![4] as string) as Record<
      string,
      unknown
    >;
    expect(secondPayload.reservationId).toBeUndefined();
    expect(secondPayload.orderId).toBe('order-2');
  });
});

describe('OrdersService.getOrder', () => {
  it('returns null when no row', async () => {
    const s = setup();
    s.pg.query.mockResolvedValueOnce(pgResult());

    const row = await s.service.getOrder('missing');

    expect(row).toBeNull();
  });

  it('returns the first row when present', async () => {
    const s = setup();
    const fakeRow = { id: 'o-1', status: 'CONFIRMED' };
    s.pg.query.mockResolvedValueOnce(pgResult([fakeRow]));

    const row = await s.service.getOrder('o-1');

    expect(row).toBe(fakeRow);
  });
});
