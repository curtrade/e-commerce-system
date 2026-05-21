import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { Kafka, Producer } from 'kafkajs';
import { ClsService, ClsStore } from 'nestjs-cls';

export interface KafkaProducerConfig {
  clientId: string;
  brokers: string[];
}

@Injectable()
export class KafkaProducerService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(KafkaProducerService.name);
  private kafka!: Kafka;
  private producer!: Producer;

  constructor(
    private readonly config: KafkaProducerConfig,
    private readonly cls: ClsService<ClsStore>,
  ) {}

  async onModuleInit(): Promise<void> {
    this.kafka = new Kafka({
      clientId: this.config.clientId,
      brokers: this.config.brokers,
      retry: { retries: 8 },
    });
    this.producer = this.kafka.producer({ allowAutoTopicCreation: true });
    await this.producer.connect();
    this.logger.log(
      `Kafka producer connected (brokers=${this.config.brokers.join(',')})`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.producer?.disconnect();
  }

  async send(topic: string, key: string, value: unknown): Promise<void> {
    let payload = value;
    if (
      payload &&
      typeof payload === 'object' &&
      'eventId' in (payload as Record<string, unknown>) &&
      !(payload as Record<string, unknown>).traceId
    ) {
      const traceId = this.cls.isActive() ? this.cls.get('traceId') : undefined;
      if (traceId) {
        payload = { ...(payload as Record<string, unknown>), traceId };
      }
    }
    await this.producer.send({
      topic,
      messages: [
        {
          key,
          value: JSON.stringify(payload),
        },
      ],
    });
  }
}
