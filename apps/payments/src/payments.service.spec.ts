import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { AppConfiguration } from './app.configuration';
import {
  createMockPg,
  createMockRedis,
  pgResult,
} from '../../../test/helpers/mock-factories';
import { ChargeDto, RefundDto } from './dto/charge.dto';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function setup(failureRate = 0) {
  const pg = createMockPg();
  const redis = createMockRedis();
  // failureRate=0 means Math.random check never trips by default.
  const cfg = { failureRate } as AppConfiguration;
  const service = new PaymentsService(pg.service, redis.service, cfg);
  return { service, pg, redis, cfg };
}

const DTO: ChargeDto = { orderId: 'order-1', amount: 42.5 };

afterEach(() => jest.restoreAllMocks());

describe('PaymentsService.charge', () => {
  it('returns cached result when Redis idempotency key is set', async () => {
    const s = setup();
    s.redis.get.mockResolvedValueOnce(
      JSON.stringify({ paymentId: 'cached-pay', status: 'CHARGED' }),
    );

    const res = await s.service.charge(DTO, 'idem-1');

    expect(res).toEqual({ paymentId: 'cached-pay', status: 'CHARGED' });
    expect(s.redis.get).toHaveBeenCalledWith('pay:idem:idem-1');
    expect(s.pg.query).not.toHaveBeenCalled();
    expect(s.redis.set).not.toHaveBeenCalled();
  });

  it('throws BadGateway when Math.random() falls below failureRate', async () => {
    const s = setup(0.5);
    jest.spyOn(Math, 'random').mockReturnValue(0.1);

    const err = await s.service.charge(DTO, 'idem-2').catch((e) => e as Error);
    expect(err).toBeInstanceOf(BadGatewayException);
    expect(err.message).toBe('Simulated payment provider failure');
    expect(s.pg.query).not.toHaveBeenCalled();
  });

  it('persists payment, caches result in Redis with 24h TTL, returns id from re-read', async () => {
    const s = setup();
    s.redis.get.mockResolvedValueOnce(null);
    jest.spyOn(Math, 'random').mockReturnValue(0.99);
    // INSERT does not return rows — just ack the call.
    s.pg.query
      .mockResolvedValueOnce(pgResult())
      .mockResolvedValueOnce(
        pgResult([{ id: 'pay-fresh', status: 'CHARGED' as const }]),
      );

    const res = await s.service.charge(DTO, 'idem-3');
    expect(res).toEqual({ paymentId: 'pay-fresh', status: 'CHARGED' });

    const insertCall = s.pg.query.mock.calls[0];
    expect(insertCall[0]).toMatch(/INSERT INTO payments/);
    expect(insertCall[0]).toMatch(/ON CONFLICT \(idempotency_key\) DO NOTHING/);
    const insertParams = insertCall[1] as unknown[];
    expect(insertParams[0]).toMatch(UUID_RE); // generated paymentId
    expect(insertParams[1]).toBe('order-1');
    expect(insertParams[2]).toBe(42.5);
    expect(insertParams[3]).toBe('idem-3');

    expect(s.pg.query.mock.calls[1][0]).toMatch(
      /SELECT id, status FROM payments/,
    );

    expect(s.redis.set).toHaveBeenCalledWith(
      'pay:idem:idem-3',
      JSON.stringify({ paymentId: 'pay-fresh', status: 'CHARGED' }),
      'EX',
      24 * 60 * 60,
    );
  });

  it('on concurrent ON CONFLICT path: re-read returns existing row, no duplicate row created', async () => {
    const s = setup();
    s.redis.get.mockResolvedValueOnce(null);
    jest.spyOn(Math, 'random').mockReturnValue(0.99);
    s.pg.query
      .mockResolvedValueOnce(pgResult()) // INSERT skipped by ON CONFLICT
      .mockResolvedValueOnce(
        pgResult([{ id: 'pay-existing', status: 'CHARGED' as const }]),
      );

    const res = await s.service.charge(DTO, 'idem-4');
    // Caller sees the existing paymentId from the concurrent writer.
    expect(res.paymentId).toBe('pay-existing');
    // Even though our INSERT was a no-op, we still cache the result so the
    // next call hits the fast path.
    expect(s.redis.set).toHaveBeenCalledWith(
      'pay:idem:idem-4',
      JSON.stringify({ paymentId: 'pay-existing', status: 'CHARGED' }),
      'EX',
      86400,
    );
  });

  it('throws BadGateway if re-read returns no row (persistence somehow failed)', async () => {
    const s = setup();
    s.redis.get.mockResolvedValueOnce(null);
    jest.spyOn(Math, 'random').mockReturnValue(0.99);
    s.pg.query
      .mockResolvedValueOnce(pgResult())
      .mockResolvedValueOnce(pgResult()); // empty re-read

    const err = await s.service.charge(DTO, 'idem-5').catch((e) => e as Error);
    expect(err).toBeInstanceOf(BadGatewayException);
    expect(err.message).toBe('Failed to persist payment');
    expect(s.redis.set).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.refund', () => {
  const REFUND: RefundDto = { paymentId: 'pay-1', reason: 'customer asked' };

  it('throws NotFoundException when payment row missing', async () => {
    const s = setup();
    s.pg.query.mockResolvedValueOnce(pgResult());

    await expect(s.service.refund(REFUND)).rejects.toThrow(NotFoundException);
    // No UPDATE ever runs.
    expect(s.pg.query).toHaveBeenCalledTimes(1);
  });

  it('returns REFUNDED without UPDATE if already refunded (idempotent)', async () => {
    const s = setup();
    s.pg.query.mockResolvedValueOnce(
      pgResult([{ id: 'pay-1', status: 'REFUNDED' }]),
    );

    const res = await s.service.refund(REFUND);

    expect(res).toEqual({ status: 'REFUNDED' });
    expect(s.pg.query).toHaveBeenCalledTimes(1);
  });

  it('throws BadGateway when payment is not in CHARGED state', async () => {
    const s = setup();
    s.pg.query.mockResolvedValueOnce(
      pgResult([{ id: 'pay-1', status: 'FAILED' }]),
    );

    await expect(s.service.refund(REFUND)).rejects.toThrow(
      'Cannot refund payment in FAILED',
    );
    expect(s.pg.query).toHaveBeenCalledTimes(1);
  });

  it('performs UPDATE to REFUNDED when payment is CHARGED', async () => {
    const s = setup();
    s.pg.query
      .mockResolvedValueOnce(pgResult([{ id: 'pay-1', status: 'CHARGED' }]))
      .mockResolvedValueOnce(pgResult());

    const res = await s.service.refund(REFUND);

    expect(res).toEqual({ status: 'REFUNDED' });
    const [updateSql, updateParams] = s.pg.query.mock.calls[1];
    expect(updateSql).toMatch(/UPDATE payments SET status = 'REFUNDED'/);
    expect(updateParams).toEqual(['pay-1']);
  });
});

describe('PaymentsService.getByOrder', () => {
  it('returns the first row when present', async () => {
    const s = setup();
    const row = { id: 'pay-1', order_id: 'o-1', status: 'CHARGED' };
    s.pg.query.mockResolvedValueOnce(pgResult([row]));

    const res = await s.service.getByOrder('o-1');
    expect(res).toBe(row);
  });

  it('returns null when no row', async () => {
    const s = setup();
    s.pg.query.mockResolvedValueOnce(pgResult());

    const res = await s.service.getByOrder('missing');
    expect(res).toBeNull();
  });
});
