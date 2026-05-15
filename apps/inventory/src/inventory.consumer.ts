import { Injectable, Logger } from '@nestjs/common';
import {
  EventEnvelope,
  KafkaConsumerService,
  OrderConfirmedPayload,
  OrderFailedPayload,
  RedisService,
} from '@app/common';
import { InventoryService } from './inventory.service';

const DEDUP_TTL_SEC = 7 * 24 * 60 * 60;

@Injectable()
export class InventoryConsumer {
  private readonly logger = new Logger(InventoryConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly inventory: InventoryService,
    private readonly redis: RedisService,
  ) {
    this.consumer.registerHandler((envelope) => this.handle(envelope));
  }

  private async handle(envelope: EventEnvelope): Promise<void> {
    const dedupKey = `inv:consumed:${envelope.eventId}`;
    const fresh = await this.redis.claimIdempotency(dedupKey, DEDUP_TTL_SEC);
    if (!fresh) {
      this.logger.debug(`Skipping duplicate event ${envelope.eventId}`);
      return;
    }

    if (envelope.eventType === 'OrderConfirmed') {
      const p = envelope.payload as OrderConfirmedPayload;
      this.logger.log(
        `Committing reservation ${p.reservationId} for order ${p.orderId}`,
      );
      await this.inventory.commit({ reservationId: p.reservationId });
    } else if (envelope.eventType === 'OrderFailed') {
      const p = envelope.payload as OrderFailedPayload;
      if (p.reservationId) {
        this.logger.log(
          `Compensating: releasing ${p.reservationId} for failed order ${p.orderId}`,
        );
        await this.inventory.release({ reservationId: p.reservationId });
      }
    }
  }
}
