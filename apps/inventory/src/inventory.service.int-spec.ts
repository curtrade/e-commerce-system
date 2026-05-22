import { ConflictException } from '@nestjs/common';
import { PgService, RedisService } from '@app/common';
import { InventoryService } from './inventory.service';
import { createTestPg, createTestRedis } from '../../../test/helpers/pg-test';
import { truncate } from '../../../test/helpers/truncate';
import { ReserveDto } from './dto/reserve.dto';

interface InventoryItemRow {
  sku: string;
  available: number;
  reserved: number;
  sold: number;
}

interface ReservationRow {
  id: string;
  status: 'PENDING' | 'COMMITTED' | 'RELEASED' | 'EXPIRED';
  expires_at: Date;
  items: { sku: string; qty: number }[];
}

async function seedStock(pg: PgService): Promise<void> {
  await pg.query(
    `INSERT INTO inventory_items (sku, available) VALUES
       ('SKU-A', 100), ('SKU-B', 50), ('SKU-C', 200)`,
  );
}

describe('InventoryService (integration)', () => {
  let pg: PgService;
  let redis: RedisService;
  let svc: InventoryService;

  beforeAll(() => {
    pg = createTestPg('inventory');
    redis = createTestRedis();
  });

  afterAll(async () => {
    await pg.onApplicationShutdown();
    await redis.onApplicationShutdown();
  });

  beforeEach(async () => {
    await truncate(pg, 'reservations', 'inventory_items');
    await seedStock(pg);

    const r = redis.raw();
    const keys = await r.keys('inv:idem:*');
    if (keys.length > 0) await r.del(...keys);

    svc = new InventoryService(pg, redis);
  });

  describe('reserve', () => {
    it('happy path: decrements available, increments reserved, creates PENDING reservation', async () => {
      const dto: ReserveDto = {
        orderId: 'o-1',
        ttlSec: 60,
        items: [
          { sku: 'SKU-A', qty: 5 },
          { sku: 'SKU-B', qty: 2 },
        ],
      };

      const res = await svc.reserve(dto, 'idem-1');
      expect(res.reservationId).toBeDefined();
      expect(new Date(res.expiresAt).getTime()).toBeGreaterThan(Date.now());

      const { rows: stock } = await pg.query<InventoryItemRow>(
        'SELECT sku, available, reserved, sold FROM inventory_items ORDER BY sku',
      );
      const bySku = Object.fromEntries(stock.map((r) => [r.sku, r]));
      expect(bySku['SKU-A']).toMatchObject({ available: 95, reserved: 5 });
      expect(bySku['SKU-B']).toMatchObject({ available: 48, reserved: 2 });
      expect(bySku['SKU-C']).toMatchObject({ available: 200, reserved: 0 });

      const { rows: reservs } = await pg.query<ReservationRow>(
        'SELECT id, status, items FROM reservations',
      );
      expect(reservs).toHaveLength(1);
      expect(reservs[0].status).toBe('PENDING');
      expect(reservs[0].items).toEqual([
        { sku: 'SKU-A', qty: 5 },
        { sku: 'SKU-B', qty: 2 },
      ]);
    });

    it('insufficient stock throws ConflictException and leaves inventory unchanged', async () => {
      const dto: ReserveDto = {
        orderId: 'o-2',
        ttlSec: 60,
        items: [{ sku: 'SKU-A', qty: 9999 }],
      };

      await expect(svc.reserve(dto, 'idem-2')).rejects.toThrow(
        ConflictException,
      );

      const { rows: stock } = await pg.query<InventoryItemRow>(
        `SELECT available, reserved FROM inventory_items WHERE sku = 'SKU-A'`,
      );
      expect(stock[0]).toMatchObject({ available: 100, reserved: 0 });

      const { rowCount } = await pg.query('SELECT 1 FROM reservations');
      expect(rowCount).toBe(0);
    });

    it('idempotent with same idemKey: second call returns cached, no double-decrement', async () => {
      const dto: ReserveDto = {
        orderId: 'o-3',
        ttlSec: 60,
        items: [{ sku: 'SKU-A', qty: 10 }],
      };

      const first = await svc.reserve(dto, 'idem-3');
      const second = await svc.reserve(dto, 'idem-3');
      expect(second).toEqual(first);

      const { rows } = await pg.query<InventoryItemRow>(
        `SELECT available, reserved FROM inventory_items WHERE sku = 'SKU-A'`,
      );
      expect(rows[0]).toMatchObject({ available: 90, reserved: 10 });

      const { rowCount } = await pg.query('SELECT 1 FROM reservations');
      expect(rowCount).toBe(1);
    });
  });

  describe('release', () => {
    it('PENDING → restores stock and marks RELEASED', async () => {
      const r = await svc.reserve(
        { orderId: 'o-r', ttlSec: 60, items: [{ sku: 'SKU-A', qty: 7 }] },
        'idem-r',
      );

      const out = await svc.release({ reservationId: r.reservationId });
      expect(out).toEqual({ status: 'RELEASED' });

      const { rows } = await pg.query<InventoryItemRow>(
        `SELECT available, reserved FROM inventory_items WHERE sku = 'SKU-A'`,
      );
      expect(rows[0]).toMatchObject({ available: 100, reserved: 0 });

      const { rows: reservs } = await pg.query<ReservationRow>(
        'SELECT status FROM reservations WHERE id = $1',
        [r.reservationId],
      );
      expect(reservs[0].status).toBe('RELEASED');
    });

    it('second release on the same reservation is a no-op (idempotent)', async () => {
      const r = await svc.reserve(
        { orderId: 'o-ri', ttlSec: 60, items: [{ sku: 'SKU-A', qty: 3 }] },
        'idem-ri',
      );
      await svc.release({ reservationId: r.reservationId });

      const out = await svc.release({ reservationId: r.reservationId });
      expect(out).toEqual({ status: 'RELEASED' });

      const { rows } = await pg.query<InventoryItemRow>(
        `SELECT available, reserved FROM inventory_items WHERE sku = 'SKU-A'`,
      );
      // Stock not double-restored.
      expect(rows[0]).toMatchObject({ available: 100, reserved: 0 });
    });
  });

  describe('commit', () => {
    it('PENDING → moves reserved into sold, marks COMMITTED', async () => {
      const r = await svc.reserve(
        { orderId: 'o-c', ttlSec: 60, items: [{ sku: 'SKU-A', qty: 4 }] },
        'idem-c',
      );

      const out = await svc.commit({ reservationId: r.reservationId });
      expect(out).toEqual({ status: 'COMMITTED' });

      const { rows } = await pg.query<InventoryItemRow>(
        `SELECT available, reserved, sold FROM inventory_items WHERE sku = 'SKU-A'`,
      );
      expect(rows[0]).toMatchObject({ available: 96, reserved: 0, sold: 4 });
    });

    it('commit after release throws ConflictException', async () => {
      const r = await svc.reserve(
        { orderId: 'o-cr', ttlSec: 60, items: [{ sku: 'SKU-A', qty: 4 }] },
        'idem-cr',
      );
      await svc.release({ reservationId: r.reservationId });

      await expect(
        svc.commit({ reservationId: r.reservationId }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('expirePending', () => {
    it('releases PENDING reservations past expires_at and restores stock', async () => {
      // ttlSec=60 is the DTO minimum; back-date expires_at directly so the
      // reaper sees it as stale.
      const r = await svc.reserve(
        { orderId: 'o-e', ttlSec: 60, items: [{ sku: 'SKU-A', qty: 6 }] },
        'idem-e',
      );
      await pg.query(
        `UPDATE reservations SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
        [r.reservationId],
      );

      const n = await svc.expirePending();
      expect(n).toBe(1);

      const { rows } = await pg.query<InventoryItemRow>(
        `SELECT available, reserved FROM inventory_items WHERE sku = 'SKU-A'`,
      );
      expect(rows[0]).toMatchObject({ available: 100, reserved: 0 });

      const { rows: reservs } = await pg.query<ReservationRow>(
        'SELECT status FROM reservations WHERE id = $1',
        [r.reservationId],
      );
      expect(reservs[0].status).toBe('RELEASED');
    });

    it('does nothing when no reservations are past expires_at', async () => {
      await svc.reserve(
        { orderId: 'o-not', ttlSec: 3600, items: [{ sku: 'SKU-A', qty: 1 }] },
        'idem-not',
      );

      const n = await svc.expirePending();
      expect(n).toBe(0);
    });
  });
});
