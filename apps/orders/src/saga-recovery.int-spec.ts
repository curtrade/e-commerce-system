import { randomUUID } from 'node:crypto';
import { PgService } from '@app/common';
import { OrdersService } from './orders.service';
import { AppConfiguration } from './app.configuration';
import { InventoryClient } from './clients/inventory.client';
import { PaymentsClient } from './clients/payments.client';
import { createTestPg } from '../../../test/helpers/pg-test';
import { truncateOrders } from '../../../test/helpers/truncate';

interface OrderRow {
  id: string;
  status: string;
  reservation_id: string | null;
  error: string | null;
}
interface OutboxRow {
  event_type: string;
  payload: Record<string, unknown>;
}

async function insertPendingOrder(
  pg: PgService,
  ageSeconds: number,
  reservationId: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await pg.query(
    `INSERT INTO orders
       (id, customer_id, email, items, total, status, attempt_id, reservation_id, created_at)
     VALUES ($1, 'cust', 'a@b.c', '[]'::jsonb, 0, 'PENDING', $2, $3,
             NOW() - ($4 || ' seconds')::interval)`,
    [id, randomUUID(), reservationId, ageSeconds],
  );
  return id;
}

describe('Saga recovery (integration)', () => {
  let pg: PgService;
  let svc: OrdersService;
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
    const inv = {
      reserve: jest.fn(),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const pay = { charge: jest.fn() };
    svc = new OrdersService(
      pg,
      inv as unknown as InventoryClient,
      pay as unknown as PaymentsClient,
      cfg,
    );
  });

  it('moves orders older than sagaTimeoutSec to FAILED_TIMEOUT and emits OrderFailed', async () => {
    const oldOrder = await insertPendingOrder(pg, 100, randomUUID());
    const freshOrder = await insertPendingOrder(pg, 10);

    const n = await svc.recoverStuckOrders();
    expect(n).toBe(1);

    const { rows: orderRows } = await pg.query<OrderRow>(
      'SELECT id, status, reservation_id, error FROM orders ORDER BY created_at DESC',
    );
    const byId = Object.fromEntries(orderRows.map((r) => [r.id, r]));
    expect(byId[oldOrder].status).toBe('FAILED_TIMEOUT');
    expect(byId[oldOrder].error).toMatch(/saga recovery/);
    expect(byId[freshOrder].status).toBe('PENDING');

    const { rows: outboxRows } = await pg.query<OutboxRow>(
      `SELECT event_type, payload FROM orders_outbox WHERE aggregate_id = $1`,
      [oldOrder],
    );
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].event_type).toBe('OrderFailed');
    expect(outboxRows[0].payload).toMatchObject({
      orderId: oldOrder,
      reservationId: byId[oldOrder].reservation_id,
    });
  });

  it('second recovery pass over the same set is a no-op (status guard via WHERE clause)', async () => {
    await insertPendingOrder(pg, 100);
    const n1 = await svc.recoverStuckOrders();
    expect(n1).toBe(1);

    const n2 = await svc.recoverStuckOrders();
    expect(n2).toBe(0);

    const { rowCount } = await pg.query('SELECT 1 FROM orders_outbox');
    expect(rowCount).toBe(1);
  });

  // Open question from brainstorm: failOrder runs as plain UPDATE + INSERT
  // outbox, without a status guard. If Layer 2 (explicit failOrder during
  // payment failure) and Layer 3 (saga-recovery against the same PENDING
  // order) both fire, we get duplicate OrderFailed events in the outbox.
  //
  // Kafka consumers dedup by eventId (TTL 7d) so downstream sees a single
  // event — but the outbox table itself ends up with two rows. This test
  // pins the current behavior; flipping it would require a status guard in
  // failOrder (or making the UPDATE conditional on status='PENDING').
  it('double failOrder on the same order produces two OrderFailed outbox rows (documented)', async () => {
    const oid = await insertPendingOrder(pg, 100, randomUUID());

    const failOrder = (
      svc as unknown as {
        failOrder: (
          orderId: string,
          status: string,
          reason: string,
          reservationId: string | null,
        ) => Promise<void>;
      }
    ).failOrder.bind(svc);

    await failOrder(oid, 'FAILED_PAYMENT', 'card declined', null);
    await failOrder(oid, 'FAILED_TIMEOUT', 'recovery sweep', null);

    const { rows } = await pg.query<{ status: string }>(
      'SELECT status FROM orders WHERE id = $1',
      [oid],
    );
    // The last writer wins on status — that itself is debatable.
    expect(rows[0].status).toBe('FAILED_TIMEOUT');

    const { rows: outboxRows } = await pg.query<OutboxRow>(
      `SELECT event_type, payload FROM orders_outbox WHERE aggregate_id = $1`,
      [oid],
    );
    expect(outboxRows).toHaveLength(2);
    expect(outboxRows.every((r) => r.event_type === 'OrderFailed')).toBe(true);
  });
});
