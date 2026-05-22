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

async function insertOutboxRows(pg: PgService, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    ids.push(id);
    await pg.query(
      `INSERT INTO orders_outbox (id, aggregate_id, topic, event_type, payload, trace_context)
       VALUES ($1, $2, 'orders.events', 'OrderConfirmed', $3::jsonb, NULL)`,
      [id, randomUUID(), JSON.stringify({ seq: i })],
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

    const { rows } = await pg.query<{ unpublished: string }>(
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

  // Documented race: pg.query() uses pool.query which auto-commits, so the
  // FOR UPDATE SKIP LOCKED row lock is released the moment SELECT returns —
  // BEFORE the for-loop calls publishRow. Two concurrent publishers can
  // therefore both observe the same unpublished rows and double-send.
  //
  // See apps/orders/src/outbox.publisher.ts:42-48 for the comment in source.
  //
  // If OutboxPublisher is ever refactored to wrap SELECT + UPDATE in a single
  // transaction, this test will start failing on the `>` assertion — change it
  // to `toBe(N)` and remove this whole block of context.
  it('two publishers race: same row may be double-published (known limitation)', async () => {
    const N = 5;
    await insertOutboxRows(pg, N);

    const producer = createMockKafkaProducer();

    // Deterministic barriers (no setTimeout):
    //  - aFirstSend resolves when publisher A enters its first send call,
    //    proving A has completed SELECT and reached publishRow.
    //  - bFirstSend resolves when publisher B enters its first send call,
    //    proving B has also SELECT'd the rows (while A is still held).
    //  - aHeld blocks A's first send until we release, so A cannot UPDATE
    //    published_at before B SELECTs.
    let releaseA!: () => void;
    let aFirstSendStarted!: () => void;
    let bFirstSendStarted!: () => void;
    const aHeld = new Promise<void>((r) => (releaseA = r));
    const aFirstSend = new Promise<void>((r) => (aFirstSendStarted = r));
    const bFirstSend = new Promise<void>((r) => (bFirstSendStarted = r));

    producer.send.mockImplementation(async () => {
      const idx = producer.send.mock.calls.length;
      if (idx === 1) {
        // A's first send — hold while signalling.
        aFirstSendStarted();
        await aHeld;
      } else if (idx === 2) {
        // While A is held, the only producer making progress is B, so its
        // first send is necessarily the 2nd send call observed.
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

    // Race proven: both publishers sent the same N rows → > N total sends.
    // If OutboxPublisher is later refactored so SELECT + UPDATE share a tx,
    // this becomes `toBe(N)` and the whole "race" comment in source can go.
    expect(producer.send.mock.calls.length).toBeGreaterThan(N);

    // All rows still end up published (eventually-correct semantics).
    const { rows } = await pg.query<{ unpublished: string }>(
      `SELECT COUNT(*)::int AS unpublished
         FROM orders_outbox WHERE published_at IS NULL`,
    );
    expect(rows[0].unpublished).toBe(0);
  });

  // NOTE: trace_context propagation into withSpan is covered honestly by the
  // unit spec ("passes row.trace_context to withSpan as parentTraceparent"),
  // where withSpan is mocked and its options can be inspected. At the
  // integration level we have no observable side-effect of the OTel context
  // beyond logs/spans, so a publish-side assertion here would not actually
  // test trace_context restoration.
});
