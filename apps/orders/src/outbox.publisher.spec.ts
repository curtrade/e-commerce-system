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
    it('selects with FOR UPDATE SKIP LOCKED and published_at IS NULL', async () => {
      const s = setup();
      s.pg.query.mockResolvedValueOnce(pgResult());

      await tick(s.publisher).call(s.publisher);

      const sql = s.pg.query.mock.calls[0][0];
      expect(sql).toMatch(/FROM orders_outbox/);
      expect(sql).toMatch(/published_at IS NULL/);
      expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    });

    it('publishes each row and marks published_at', async () => {
      const s = setup();
      const row1 = makeRow({ id: 'r-1' });
      const row2 = makeRow({ id: 'r-2', event_type: 'OrderFailed' });
      s.pg.query.mockResolvedValueOnce(pgResult([row1, row2]));

      await tick(s.publisher).call(s.publisher);

      expect(s.producer.send).toHaveBeenCalledTimes(2);
      // First publish: envelope shape
      const [topic, key, value] = s.producer.send.mock.calls[0];
      expect(topic).toBe('orders.events');
      expect(key).toBe('agg-1');
      expect(value).toEqual({
        eventId: 'r-1',
        eventType: 'OrderConfirmed',
        occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        payload: { hello: 'world' },
      });

      // UPDATE published_at fired once per row (in addition to the SELECT).
      const updates = s.pg.query.mock.calls.slice(1);
      expect(updates).toHaveLength(2);
      for (const [sql] of updates) {
        expect(sql).toMatch(/UPDATE orders_outbox SET published_at = NOW\(\)/);
      }
      expect(updates[0][1]).toEqual(['r-1']);
      expect(updates[1][1]).toEqual(['r-2']);
    });

    it('on producer.send failure: bumps attempts and does not mark published', async () => {
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
      // Suspend the SELECT until we resolve it manually.
      let resolveSelect!: (v: unknown) => void;
      s.pg.query.mockImplementationOnce(
        () => new Promise((r) => (resolveSelect = r)),
      );

      const first = tick(s.publisher).call(s.publisher);
      // Second tick must hit the `if (this.running) return` early-out.
      const second = tick(s.publisher).call(s.publisher);
      await second;

      // Only the SELECT from the first tick has been issued; the second tick
      // did not query at all.
      expect(s.pg.query).toHaveBeenCalledTimes(1);

      resolveSelect({ rows: [], rowCount: 0 });
      await first;
    });
  });
});
