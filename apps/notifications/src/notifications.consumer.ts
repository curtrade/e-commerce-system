import { Injectable, Logger } from '@nestjs/common';
import {
  EventEnvelope,
  KafkaConsumerService,
  OrderConfirmedPayload,
  OrderFailedPayload,
  RedisService,
} from '@app/common';
import { NotificationsService } from './notifications.service';

const DEDUP_TTL_SEC = 7 * 24 * 60 * 60;

@Injectable()
export class NotificationsConsumer {
  private readonly logger = new Logger(NotificationsConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly notifications: NotificationsService,
    private readonly redis: RedisService,
  ) {
    this.consumer.registerHandler((envelope) => this.handle(envelope));
  }

  private async handle(envelope: EventEnvelope): Promise<void> {
    const dedupKey = `notify:consumed:${envelope.eventId}`;
    if (!(await this.redis.claimIdempotency(dedupKey, DEDUP_TTL_SEC))) {
      this.logger.debug(`Skipping duplicate event ${envelope.eventId}`);
      return;
    }

    if (envelope.eventType === 'OrderConfirmed') {
      const p = envelope.payload as OrderConfirmedPayload;
      await this.notifications.sendOrderConfirmedEmail({
        orderId: p.orderId,
        email: p.email,
        total: p.total,
      });
    } else if (envelope.eventType === 'OrderFailed') {
      const p = envelope.payload as OrderFailedPayload & { email?: string };
      await this.notifications.sendOrderFailedEmail({
        orderId: p.orderId,
        email: p.email,
        reason: p.reason,
      });
    }
  }
}
