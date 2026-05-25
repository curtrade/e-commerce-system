jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    withSpan: jest.fn(async (_tracer, _span, fn, _opts) => {
      const fakeSpan = {
        setAttribute: jest.fn(),
        recordException: jest.fn(),
        setStatus: jest.fn(),
        end: jest.fn(),
      };
      return fn(fakeSpan);
    }),
  };
});

import { withSpan } from '@app/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { OutboxPublisher } from './outbox.publisher';
import {
  createMockPg,
  createMockKafkaProducer,
  pgResult,
} from '../../../test/helpers/mock-factories';

const withSpanMock = withSpan as unknown as jest.Mock;

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'row-1',
    aggregate_id: 'agg-1',
    topic: 'orders.events',
    event_type: 'OrderConfirmed',
    payload: { hello: 'world' },
    trace_context: null,
    attempts: 0,
    ...overrides,
  };
}

function setup() {
  const pg = createMockPg();
  const producer = createMockKafkaProducer();
  const scheduler = {
    addInterval: jest.fn(),
  } as unknown as jest.Mocked<SchedulerRegistry>;
  const publisher = new OutboxPublisher(pg.service, producer.service, scheduler);
  return { publisher, pg, producer, scheduler };
}

type Tick = () => Promise<void>;
const tick = (p: OutboxPublisher): Tick => (p as unknown as { tick: Tick }).tick;

describe('OutboxPublisher', () => {
  beforeEach(() => {
    withSpanMock.mockClear();
    jest.spyOn(Date, 'now').mockRestore();
  });

  describe('onModuleInit', () => {
    it('registers a polling interval under the expected name', () => {
      jest.useFakeTimers();
      try {
        const s = setup();
        s.publisher.onModuleInit();
        expect(s.scheduler.addInterval).toHaveBeenCalledTimes(1);
        expect(s.scheduler.addInterval.mock.calls[0][0]).toBe(
          'orders-outbox-publisher',
        );
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('tick()', () => {
    it('selects with FOR UPDATE SKIP LOCKED, published_at IS NULL, and attempts < MAX', async () => {
      const s = setup();
      s.pg.query.mockResolvedValueOnce(pgResult());

      await tick(s.publisher).call(s.publisher);

      const sql = s.pg.query.mock.calls[0][0];
      expect(sql).toMatch(/FROM orders_outbox/);
      expect(sql).toMatch(/published_at IS NULL/);
      expect(sql).toMatch(/attempts < \$1/);
      expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
      expect(s.pg.query.mock.calls[0][1]).toEqual([10]);
    });

    it('publishes each row and marks published_at', async () => {
      const s = setup();
      const row1 = makeRow({ id: 'r-1' });
      const row2 = makeRow({ id: 'r-2', event_type: 'OrderFailed' });
      s.pg.query.mockResolvedValueOnce(pgResult([row1, row2]));

      await tick(s.publisher).call(s.publisher);

      expect(s.producer.send).toHaveBeenCalledTimes(2);
      const [topic, key, value] = s.producer.send.mock.calls[0];
      expect(topic).toBe('orders.events');
      expect(key).toBe('agg-1');
      expect(value).toEqual({
        eventId: 'r-1',
        eventType: 'OrderConfirmed',
        occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        payload: { hello: 'world' },
      });

      const updates = s.pg.query.mock.calls.slice(1);
      expect(updates).toHaveLength(2);
      for (const [sql] of updates) {
        expect(sql).toMatch(/UPDATE orders_outbox SET published_at = NOW\(\)/);
      }
      expect(updates[0][1]).toEqual(['r-1']);
      expect(updates[1][1]).toEqual(['r-2']);
    });

    it('on producer.send failure: bumps attempts, breaks batch, and does not mark published', async () => {
      const s = setup();
      s.pg.query.mockResolvedValueOnce(pgResult([makeRow({ id: 'r-x' })]));
      s.producer.send.mockRejectedValueOnce(new Error('broker down'));

      await tick(s.publisher).call(s.publisher);

      const updates = s.pg.query.mock.calls.slice(1);
      expect(updates).toHaveLength(1);
      const [sql, params] = updates[0];
      expect(sql).toMatch(/SET attempts = attempts \+ 1/);
      expect(sql).not.toMatch(/published_at/);
      expect(params).toEqual(['r-x']);
    });

    it('circuit breaker: stops batch on first failure, remaining rows are not attempted', async () => {
      const s = setup();
      const row1 = makeRow({ id: 'r-1' });
      const row2 = makeRow({ id: 'r-2' });
      const row3 = makeRow({ id: 'r-3' });
      s.pg.query.mockResolvedValueOnce(pgResult([row1, row2, row3]));
      s.producer.send.mockRejectedValueOnce(new Error('broker down'));

      await tick(s.publisher).call(s.publisher);

      expect(s.producer.send).toHaveBeenCalledTimes(1);
    });

    it('exponential backoff: skips tick while in backoff window', async () => {
      const s = setup();
      s.pg.query.mockResolvedValueOnce(pgResult([makeRow()]));
      s.producer.send.mockRejectedValueOnce(new Error('broker down'));

      const now = 1_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(now);

      await tick(s.publisher).call(s.publisher);
      expect(s.pg.query).toHaveBeenCalledTimes(2); // SELECT + attempts UPDATE

      // Next tick within backoff window — should be skipped
      jest.spyOn(Date, 'now').mockReturnValue(now + 500);
      await tick(s.publisher).call(s.publisher);
      expect(s.pg.query).toHaveBeenCalledTimes(2); // no new queries

      // After backoff expires — should proceed
      jest.spyOn(Date, 'now').mockReturnValue(now + 3000);
      s.pg.query.mockResolvedValueOnce(pgResult());
      await tick(s.publisher).call(s.publisher);
      expect(s.pg.query).toHaveBeenCalledTimes(3); // new SELECT
    });

    it('resets backoff after a successful batch', async () => {
      const s = setup();

      // First tick fails
      s.pg.query.mockResolvedValueOnce(pgResult([makeRow()]));
      s.producer.send.mockRejectedValueOnce(new Error('broker down'));
      const now = 1_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(now);
      await tick(s.publisher).call(s.publisher);

      // Skip past backoff
      jest.spyOn(Date, 'now').mockReturnValue(now + 10_000);

      // Second tick succeeds with rows
      s.pg.query.mockResolvedValueOnce(pgResult([makeRow({ id: 'r-ok' })]));
      s.producer.send.mockResolvedValueOnce(undefined);
      await tick(s.publisher).call(s.publisher);

      // Third tick should fire immediately (no backoff)
      jest.spyOn(Date, 'now').mockReturnValue(now + 10_001);
      s.pg.query.mockResolvedValueOnce(pgResult());
      await tick(s.publisher).call(s.publisher);
      // SELECT was called: 1 (fail) + 1 (success) + 1 (immediate) + attempts UPDATE = 5 total
      expect(s.pg.query).toHaveBeenCalledTimes(5);
    });

    it('passes row.trace_context to withSpan as parentTraceparent', async () => {
      const s = setup();
      const tp = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
      s.pg.query.mockResolvedValueOnce(pgResult([makeRow({ trace_context: tp })]));

      await tick(s.publisher).call(s.publisher);

      expect(withSpanMock).toHaveBeenCalledTimes(1);
      const opts = withSpanMock.mock.calls[0][3];
      expect(opts).toEqual({ parentTraceparent: tp });
    });

    it('skips overlapping ticks via the running guard', async () => {
      const s = setup();
      let resolveSelect!: (v: unknown) => void;
      s.pg.query.mockImplementationOnce(
        () => new Promise((r) => (resolveSelect = r)),
      );

      const first = tick(s.publisher).call(s.publisher);
      const second = tick(s.publisher).call(s.publisher);
      await second;

      expect(s.pg.query).toHaveBeenCalledTimes(1);

      resolveSelect({ rows: [], rowCount: 0 });
      await first;
    });
  });
});
