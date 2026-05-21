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
  attempts: number;
}

const POLL_INTERVAL_MS = 1000;

@Injectable()
export class OutboxPublisher implements OnModuleInit {
  private readonly logger = new Logger(OutboxPublisher.name);
  private running = false;

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
    this.running = true;
    try {
      // SKIP LOCKED ⇒ multiple replicas can poll without stepping on each other.
      const { rows } = await this.pg.query<OutboxRow>(
        `SELECT id, aggregate_id, topic, event_type, payload, attempts
           FROM orders_outbox
          WHERE published_at IS NULL
          ORDER BY created_at
          LIMIT 50
          FOR UPDATE SKIP LOCKED`,
      );
      for (const row of rows) {
        await withSpan('orders-outbox', 'outbox.publish', async (span) => {
          span.setAttribute('outbox.row.id', row.id);
          span.setAttribute('outbox.event_type', row.event_type);
          return this.publishRow(row);
        });
      }
    } catch (err) {
      this.logger.error(`Outbox tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
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
      await this.pg.query(
        `UPDATE orders_outbox SET published_at = NOW() WHERE id = $1`,
        [row.id],
      );
    } catch (err) {
      this.logger.error(
        `Failed to publish outbox row ${row.id}: ${(err as Error).message}`,
      );
      await this.pg.query(
        `UPDATE orders_outbox SET attempts = attempts + 1 WHERE id = $1`,
        [row.id],
      );
    }
  }
}
