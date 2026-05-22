import { PgService, RedisService } from '@app/common';
import { PaymentsService } from './payments.service';
import { AppConfiguration } from './app.configuration';
import { createTestPg, createTestRedis } from '../../../test/helpers/pg-test';
import { truncatePayments } from '../../../test/helpers/truncate';

interface PaymentRow {
  id: string;
  order_id: string;
  amount: string;
  status: 'CHARGED' | 'REFUNDED' | 'FAILED';
  idempotency_key: string;
}

describe('PaymentsService (integration)', () => {
  let pg: PgService;
  let redis: RedisService;
  let svc: PaymentsService;
  const cfg = { failureRate: 0 } as AppConfiguration;

  beforeAll(() => {
    pg = createTestPg('payments');
    redis = createTestRedis();
  });

  afterAll(async () => {
    await pg.onApplicationShutdown();
    await redis.onApplicationShutdown();
  });

  beforeEach(async () => {
    await truncatePayments(pg);
    // Flush only our key namespace so we don't trample other suites' Redis.
    const r = redis.raw();
    const keys = await r.keys('pay:idem:*');
    if (keys.length > 0) await r.del(...keys);
    svc = new PaymentsService(pg, redis, cfg);
  });

  describe('charge', () => {
    it('first call inserts payment row, second call with same idemKey returns cached without new INSERT', async () => {
      const idem = 'idem-int-1';
      const first = await svc.charge({ orderId: 'o-1', amount: 9.99 }, idem);
      expect(first.status).toBe('CHARGED');

      const { rowCount: afterFirst } = await pg.query(
        'SELECT 1 FROM payments WHERE idempotency_key = $1',
        [idem],
      );
      expect(afterFirst).toBe(1);

      const second = await svc.charge({ orderId: 'o-1', amount: 9.99 }, idem);
      expect(second).toEqual(first);

      const { rowCount: afterSecond } = await pg.query(
        'SELECT 1 FROM payments WHERE idempotency_key = $1',
        [idem],
      );
      expect(afterSecond).toBe(1); // still exactly one row
    });

    it('concurrent calls with same idemKey produce exactly one row (ON CONFLICT)', async () => {
      const idem = 'idem-int-conc';
      // Bypass Redis cache for both by forcing a cache-miss race: pre-empt the
      // cache layer by deleting any key before each call's get(). Simpler:
      // both calls start while cache is empty.
      const [a, b] = await Promise.all([
        svc.charge({ orderId: 'o-2', amount: 5 }, idem),
        svc.charge({ orderId: 'o-2', amount: 5 }, idem),
      ]);

      // Both return same paymentId (the surviving INSERT).
      expect(a.paymentId).toBe(b.paymentId);
      const { rowCount } = await pg.query(
        'SELECT 1 FROM payments WHERE idempotency_key = $1',
        [idem],
      );
      expect(rowCount).toBe(1);
    });

    it('caches result in Redis with TTL after first charge', async () => {
      const idem = 'idem-int-cache';
      await svc.charge({ orderId: 'o-3', amount: 1.5 }, idem);

      const cached = await redis.raw().get(`pay:idem:${idem}`);
      expect(cached).not.toBeNull();
      const parsed = JSON.parse(cached!);
      expect(parsed.status).toBe('CHARGED');

      const ttl = await redis.raw().ttl(`pay:idem:${idem}`);
      // 24h ± a few seconds
      expect(ttl).toBeGreaterThan(24 * 60 * 60 - 60);
      expect(ttl).toBeLessThanOrEqual(24 * 60 * 60);
    });
  });

  describe('refund state machine', () => {
    it('CHARGED → REFUNDED, repeat refund is idempotent', async () => {
      const charge = await svc.charge(
        { orderId: 'o-r', amount: 12 },
        'idem-refund',
      );

      const first = await svc.refund({
        paymentId: charge.paymentId,
        reason: 'asked',
      });
      expect(first).toEqual({ status: 'REFUNDED' });

      const second = await svc.refund({
        paymentId: charge.paymentId,
        reason: 'asked again',
      });
      expect(second).toEqual({ status: 'REFUNDED' });

      const { rows } = await pg.query<PaymentRow>(
        'SELECT status FROM payments WHERE id = $1',
        [charge.paymentId],
      );
      expect(rows[0].status).toBe('REFUNDED');
    });

    it('refund of FAILED payment is rejected', async () => {
      // Insert a FAILED payment directly — service.charge can't produce one.
      const { rows } = await pg.query<{ id: string }>(
        `INSERT INTO payments (id, order_id, amount, status, idempotency_key)
         VALUES (gen_random_uuid(), 'o-fail', 1, 'FAILED', 'idem-failed-row')
         RETURNING id`,
      );
      const id = rows[0].id;

      await expect(svc.refund({ paymentId: id, reason: 'try' })).rejects.toThrow(
        /Cannot refund payment in FAILED/,
      );
    });
  });
});
