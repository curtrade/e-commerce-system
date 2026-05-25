import { randomUUID } from 'node:crypto';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PgService, KafkaProducerService } from '@app/common';
import { OutboxPublisher } from './outbox.publisher';
import { createTestPg } from '../../../test/helpers/pg-test';
import { truncateOrders } from '../../../test/helpers/truncate';
import {
  createMockKafkaProducer,
  MockKafkaProducer,
} from '../../../test/helpers/mock-factories';

type Tick = () => Promise<void>;
const tick = (p: OutboxPublisher): Tick =>
  (p as unknown as { tick: Tick }).tick.bind(p);

async function insertOutboxRows(
  pg: PgService,
  n: number,
  attempts = 0,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    ids.push(id);
    await pg.query(
      `INSERT INTO orders_outbox (id, aggregate_id, topic, event_type, payload, trace_context, attempts)
       VALUES ($1, $2, 'orders.events', 'OrderConfirmed', $3::jsonb, NULL, $4)`,
      [id, randomUUID(), JSON.stringify({ seq: i }), attempts],
    );
  }
  return ids;
}

function makePublisher(
  pg: PgService,
  producer: KafkaProducerService,
): OutboxPublisher {
  const scheduler = {
    addInterval: jest.fn(),
  } as unknown as SchedulerRegistry;
  return new OutboxPublisher(pg, producer, scheduler);
}

describe('OutboxPublisher (integration)', () => {
  let pg: PgService;

  beforeAll(() => {
    pg = createTestPg();
  });

  afterAll(async () => {
    await pg.onApplicationShutdown();
  });

  beforeEach(async () => {
    await truncateOrders(pg);
  });

  it('single publisher: publishes every unpublished row exactly once and marks published_at', async () => {
    const N = 5;
    const ids = await insertOutboxRows(pg, N);
    const producer = createMockKafkaProducer();
    const pub = makePublisher(pg, producer.service);

    await tick(pub)();

    expect(producer.send).toHaveBeenCalledTimes(N);
    const sentIds = producer.send.mock.calls.map((c) => c[2] as { eventId: string });
    expect(sentIds.map((e) => e.eventId).sort()).toEqual([...ids].sort());

    const { rows } = await pg.query<{ unpublished: number }>(
      `SELECT COUNT(*)::int AS unpublished
         FROM orders_outbox WHERE published_at IS NULL`,
    );
    expect(rows[0].unpublished).toBe(0);
  });

  it('producer.send failure: row stays unpublished and attempts is incremented', async () => {
    const [id] = await insertOutboxRows(pg, 1);
    const producer = createMockKafkaProducer();
    producer.send.mockRejectedValueOnce(new Error('broker down'));
    const pub = makePublisher(pg, producer.service);

    await tick(pub)();

    const { rows } = await pg.query<{
      attempts: number;
      published_at: Date | null;
    }>('SELECT attempts, published_at FROM orders_outbox WHERE id = $1', [id]);
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].published_at).toBeNull();
  });

  it('rows at max attempts are skipped by the poller', async () => {
    await insertOutboxRows(pg, 2, 10);
    const producer = createMockKafkaProducer();
    const pub = makePublisher(pg, producer.service);

    await tick(pub)();

    expect(producer.send).not.toHaveBeenCalled();

    const { rows } = await pg.query<{ unpublished: number }>(
      `SELECT COUNT(*)::int AS unpublished
         FROM orders_outbox WHERE published_at IS NULL`,
    );
    expect(rows[0].unpublished).toBe(2);
  });

  it('circuit breaker: first failure stops the batch, remaining rows are not attempted', async () => {
    await insertOutboxRows(pg, 3);
    const producer = createMockKafkaProducer();
    producer.send.mockRejectedValue(new Error('broker down'));
    const pub = makePublisher(pg, producer.service);

    await tick(pub)();

    expect(producer.send).toHaveBeenCalledTimes(1);

    const { rows } = await pg.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM orders_outbox WHERE attempts > 0`,
    );
    expect(rows[0].cnt).toBe(1);
  });

  // Documented race: pg.query() uses pool.query which auto-commits, so the
  // FOR UPDATE SKIP LOCKED row lock is released the moment SELECT returns —
  // BEFORE the for-loop calls publishRow. Two concurrent publishers can
  // therefore both observe the same unpublished rows and double-send.
  //
  // If OutboxPublisher is ever refactored to wrap SELECT + UPDATE in a single
  // transaction, this test will start failing on the `>` assertion — change it
  // to `toBe(N)` and remove this whole block of context.
  it('two publishers race: same row may be double-published (known limitation)', async () => {
    const N = 5;
    await insertOutboxRows(pg, N);

    const producer = createMockKafkaProducer();

    let releaseA!: () => void;
    let aFirstSendStarted!: () => void;
    let bFirstSendStarted!: () => void;
    const aHeld = new Promise<void>((r) => (releaseA = r));
    const aFirstSend = new Promise<void>((r) => (aFirstSendStarted = r));
    const bFirstSend = new Promise<void>((r) => (bFirstSendStarted = r));

    producer.send.mockImplementation(async () => {
      const idx = producer.send.mock.calls.length;
      if (idx === 1) {
        aFirstSendStarted();
        await aHeld;
      } else if (idx === 2) {
        bFirstSendStarted();
      }
    });

    const pubA = makePublisher(pg, producer.service);
    const pubB = makePublisher(pg, producer.service);

    const aPromise = tick(pubA)();
    await aFirstSend;
    const bPromise = tick(pubB)();
    await bFirstSend;
    releaseA();
    await Promise.all([aPromise, bPromise]);

    expect(producer.send.mock.calls.length).toBeGreaterThan(N);

    const { rows } = await pg.query<{ unpublished: number }>(
      `SELECT COUNT(*)::int AS unpublished
         FROM orders_outbox WHERE published_at IS NULL`,
    );
    expect(rows[0].unpublished).toBe(0);
  });
});
