import { ConflictException, NotFoundException } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import {
  createMockPg,
  createMockRedis,
  pgResult,
} from '../../../test/helpers/mock-factories';
import { ReserveDto } from './dto/reserve.dto';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function setup() {
  const pg = createMockPg();
  const redis = createMockRedis();
  const service = new InventoryService(pg.service, redis.service);
  return { service, pg, redis };
}

const RESERVE_DTO: ReserveDto = {
  orderId: 'o-1',
  ttlSec: 900,
  // Deliberately out of alphabetical order to exercise the sort.
  items: [
    { sku: 'SKU-Z', qty: 2 },
    { sku: 'SKU-A', qty: 1 },
    { sku: 'SKU-M', qty: 3 },
  ],
};

describe('InventoryService.reserve', () => {
  it('returns cached result when Redis idempotency key is present', async () => {
    const s = setup();
    const cached = {
      reservationId: 'cached-res',
      expiresAt: '2030-01-01T00:00:00.000Z',
    };
    s.redis.get.mockResolvedValueOnce(JSON.stringify(cached));

    const res = await s.service.reserve(RESERVE_DTO, 'idem-1');

    expect(res).toEqual(cached);
    expect(s.redis.get).toHaveBeenCalledWith('inv:idem:idem-1');
    expect(s.pg.withTransaction).not.toHaveBeenCalled();
  });

  it('throws ConflictException on insufficient stock and rolls back via withTransaction', async () => {
    const s = setup();
    s.redis.get.mockResolvedValueOnce(null);
    // First UPDATE returns rowCount=0 → insufficient stock for first SKU.
    s.pg.txClientQuery.mockResolvedValueOnce(pgResult());

    const err = await s.service
      .reserve(RESERVE_DTO, 'idem-2')
      .catch((e) => e as Error);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(/Insufficient stock for SKU SKU-A/); // sorted first
  });

  it('updates stock in sorted SKU order then inserts reservation', async () => {
    const s = setup();
    s.redis.get.mockResolvedValueOnce(null);
    // Three successful UPDATEs + one INSERT.
    s.pg.txClientQuery.mockResolvedValue({
      ...pgResult(),
      rowCount: 1,
    });

    const res = await s.service.reserve(RESERVE_DTO, 'idem-3');

    expect(res.reservationId).toMatch(UUID_RE);
    expect(res.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Sorted: SKU-A, SKU-M, SKU-Z then INSERT.
    const calls = s.pg.txClientQuery.mock.calls;
    expect(calls).toHaveLength(4);

    const skuOrder = calls
      .slice(0, 3)
      .map((c) => (c[1] as unknown[])[0] as string);
    expect(skuOrder).toEqual(['SKU-A', 'SKU-M', 'SKU-Z']);

    // Qty per call:
    expect((calls[0][1] as unknown[])[1]).toBe(1); // SKU-A qty=1
    expect((calls[1][1] as unknown[])[1]).toBe(3); // SKU-M qty=3
    expect((calls[2][1] as unknown[])[1]).toBe(2); // SKU-Z qty=2

    expect(calls[3][0]).toMatch(/INSERT INTO reservations/);
    const insertParams = calls[3][1] as unknown[];
    expect(insertParams[0]).toBe(res.reservationId);
    expect(insertParams[1]).toBe('o-1');
    const itemsJson = JSON.parse(insertParams[2] as string) as {
      sku: string;
    }[];
    expect(itemsJson.map((it) => it.sku)).toEqual(['SKU-A', 'SKU-M', 'SKU-Z']);
  });

  it('caches reservation in Redis with 24h TTL', async () => {
    const s = setup();
    s.redis.get.mockResolvedValueOnce(null);
    s.pg.txClientQuery.mockResolvedValue({ ...pgResult(), rowCount: 1 });

    const res = await s.service.reserve(RESERVE_DTO, 'idem-4');

    expect(s.redis.set).toHaveBeenCalledWith(
      'inv:idem:idem-4',
      JSON.stringify(res),
      'EX',
      24 * 60 * 60,
    );
  });
});

describe('InventoryService.release', () => {
  it('throws NotFoundException when reservation missing', async () => {
    const s = setup();
    s.pg.txClientQuery.mockResolvedValueOnce(pgResult());

    await expect(
      s.service.release({ reservationId: 'r-missing' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('PENDING → updates stock + sets RELEASED', async () => {
    const s = setup();
    const items = [
      { sku: 'SKU-A', qty: 2 },
      { sku: 'SKU-B', qty: 1 },
    ];
    s.pg.txClientQuery.mockResolvedValueOnce(
      pgResult([{ id: 'r-1', items, status: 'PENDING' }]),
    );
    s.pg.txClientQuery.mockResolvedValue({ ...pgResult(), rowCount: 1 });

    const res = await s.service.release({ reservationId: 'r-1' });

    expect(res).toEqual({ status: 'RELEASED' });
    // SELECT + 2 stock UPDATEs + reservation UPDATE = 4 calls.
    expect(s.pg.txClientQuery).toHaveBeenCalledTimes(4);
    expect(s.pg.txClientQuery.mock.calls[3][0]).toMatch(
      /UPDATE reservations SET status = 'RELEASED'/,
    );
  });

  it.each(['COMMITTED', 'RELEASED', 'EXPIRED'] as const)(
    'is a no-op when reservation status is %s (idempotent)',
    async (status) => {
      const s = setup();
      s.pg.txClientQuery.mockResolvedValueOnce(
        pgResult([{ id: 'r-1', items: [], status }]),
      );

      const res = await s.service.release({ reservationId: 'r-1' });
      expect(res).toEqual({ status });
      // Only the SELECT — no UPDATEs.
      expect(s.pg.txClientQuery).toHaveBeenCalledTimes(1);
    },
  );
});

describe('InventoryService.commit', () => {
  it('throws NotFoundException when reservation missing', async () => {
    const s = setup();
    s.pg.txClientQuery.mockResolvedValueOnce(pgResult());

    await expect(
      s.service.commit({ reservationId: 'r-missing' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('COMMITTED → no-op (idempotent)', async () => {
    const s = setup();
    s.pg.txClientQuery.mockResolvedValueOnce(
      pgResult([{ id: 'r-1', items: [], status: 'COMMITTED' }]),
    );

    const res = await s.service.commit({ reservationId: 'r-1' });
    expect(res).toEqual({ status: 'COMMITTED' });
    expect(s.pg.txClientQuery).toHaveBeenCalledTimes(1);
  });

  it.each(['RELEASED', 'EXPIRED'] as const)(
    'throws ConflictException when committing from %s',
    async (status) => {
      const s = setup();
      s.pg.txClientQuery.mockResolvedValueOnce(
        pgResult([{ id: 'r-1', items: [], status }]),
      );

      await expect(s.service.commit({ reservationId: 'r-1' })).rejects.toThrow(
        ConflictException,
      );
    },
  );

  it('PENDING → updates items (reserved→sold) and sets COMMITTED', async () => {
    const s = setup();
    const items = [
      { sku: 'SKU-A', qty: 2 },
      { sku: 'SKU-B', qty: 1 },
    ];
    s.pg.txClientQuery.mockResolvedValueOnce(
      pgResult([{ id: 'r-1', items, status: 'PENDING' }]),
    );
    s.pg.txClientQuery.mockResolvedValue({ ...pgResult(), rowCount: 1 });

    const res = await s.service.commit({ reservationId: 'r-1' });
    expect(res).toEqual({ status: 'COMMITTED' });
    expect(s.pg.txClientQuery.mock.calls[1][0]).toMatch(
      /SET reserved = reserved - \$2,\s+sold = sold \+ \$2/,
    );
    expect(s.pg.txClientQuery.mock.calls[3][0]).toMatch(
      /UPDATE reservations SET status = 'COMMITTED'/,
    );
  });
});

describe('InventoryService.expirePending', () => {
  it('returns 0 when no pending reservations need expiring', async () => {
    const s = setup();
    s.pg.query.mockResolvedValueOnce(pgResult());

    const n = await s.service.expirePending();
    expect(n).toBe(0);
    expect(s.pg.withTransaction).not.toHaveBeenCalled();
  });

  it('selects PENDING reservations past expires_at and releases each one', async () => {
    const s = setup();
    s.pg.query.mockResolvedValueOnce(pgResult([{ id: 'r-1' }, { id: 'r-2' }]));
    // Each release call: SELECT → empty items → UPDATE reservation status.
    // To keep this simple, mock release to succeed via the tx client returning
    // a PENDING reservation each time.
    s.pg.txClientQuery.mockResolvedValue(
      pgResult([{ id: 'r-1', items: [], status: 'PENDING' }]),
    );

    const n = await s.service.expirePending();
    expect(n).toBe(2);
    // Two release() calls → two transactions.
    expect(s.pg.withTransaction).toHaveBeenCalledTimes(2);

    const selectSql = s.pg.query.mock.calls[0][0];
    expect(selectSql).toMatch(/status = 'PENDING' AND expires_at < NOW\(\)/);
  });
});
