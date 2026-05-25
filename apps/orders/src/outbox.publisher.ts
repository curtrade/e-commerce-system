import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  EventEnvelope,
  KafkaProducerService,
  PgService,
  withSpan,
} from '@app/common';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  topic: string;
  event_type: string;
  payload: Record<string, unknown>;
  trace_context: string | null;
  attempts: number;
}

const POLL_INTERVAL_MS = 1000;
const MAX_ATTEMPTS = 10;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

@Injectable()
export class OutboxPublisher implements OnModuleInit {
  private readonly logger = new Logger(OutboxPublisher.name);
  private running = false;
  private consecutiveFailures = 0;
  private nextRetryAt = 0;

  constructor(
    private readonly pg: PgService,
    private readonly producer: KafkaProducerService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const interval = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
    this.scheduler.addInterval('orders-outbox-publisher', interval);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    if (Date.now() < this.nextRetryAt) return;
    this.running = true;
    try {
      const { rows } = await this.pg.query<OutboxRow>(
        `SELECT id, aggregate_id, topic, event_type, payload, trace_context, attempts
           FROM orders_outbox
          WHERE published_at IS NULL
            AND attempts < $1
          ORDER BY created_at
          LIMIT 50
          FOR UPDATE SKIP LOCKED`,
        [MAX_ATTEMPTS],
      );

      let failed = false;
      for (const row of rows) {
        try {
          await withSpan(
            'orders-outbox',
            'outbox.publish',
            async (span) => {
              span.setAttribute('outbox.row.id', row.id);
              span.setAttribute('outbox.event_type', row.event_type);
              return this.publishRow(row);
            },
            { parentTraceparent: row.trace_context },
          );
        } catch (err) {
          this.logger.error(
            `Failed to publish outbox row ${row.id}: ${(err as Error).message}`,
          );
          if (row.attempts + 1 >= MAX_ATTEMPTS) {
            this.logger.warn(
              `Outbox row ${row.id} exhausted ${MAX_ATTEMPTS} attempts, will not be retried`,
            );
          }
          this.applyBackoff();
          failed = true;
          break;
        }
      }

      if (!failed) {
        this.consecutiveFailures = 0;
        this.nextRetryAt = 0;
      }
    } catch (err) {
      this.logger.error(`Outbox tick failed: ${(err as Error).message}`);
      this.applyBackoff();
    } finally {
      this.running = false;
    }
  }

  private applyBackoff(): void {
    this.consecutiveFailures++;
    const delayMs = Math.min(
      BACKOFF_BASE_MS * 2 ** this.consecutiveFailures,
      BACKOFF_MAX_MS,
    );
    this.nextRetryAt = Date.now() + delayMs;
    this.logger.warn(`Outbox backing off for ${delayMs}ms`);
  }

  private async publishRow(row: OutboxRow): Promise<void> {
    const envelope: EventEnvelope = {
      eventId: row.id,
      eventType: row.event_type,
      occurredAt: new Date().toISOString(),
      payload: row.payload,
    };

    try {
      await this.producer.send(row.topic, row.aggregate_id, envelope);
    } catch (sendErr) {
      try {
        await this.pg.query(
          `UPDATE orders_outbox SET attempts = attempts + 1 WHERE id = $1`,
          [row.id],
        );
      } catch (dbErr) {
        this.logger.error(
          `Failed to bump attempts for row ${row.id}: ${(dbErr as Error).message}`,
        );
      }
      throw sendErr;
    }

    try {
      await this.pg.query(
        `UPDATE orders_outbox SET published_at = NOW() WHERE id = $1`,
        [row.id],
      );
    } catch (dbErr) {
      this.logger.error(
        `Row ${row.id} sent to Kafka but published_at UPDATE failed: ${(dbErr as Error).message}`,
      );
    }
  }
}
