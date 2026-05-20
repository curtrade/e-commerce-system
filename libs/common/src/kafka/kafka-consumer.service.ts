import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Consumer, EachMessagePayload, Kafka } from 'kafkajs';
import { ClsService } from 'nestjs-cls';
import { EventEnvelope } from '../events/event-envelope';
import { TraceStore } from '../als/cls-store';

export interface KafkaConsumerConfig {
  clientId: string;
  brokers: string[];
  groupId: string;
  topics: string[];
}

export type EnvelopeHandler = (
  envelope: EventEnvelope,
  raw: EachMessagePayload,
) => Promise<void>;

@Injectable()
export class KafkaConsumerService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(KafkaConsumerService.name);
  private kafka!: Kafka;
  private consumer!: Consumer;
  private handler?: EnvelopeHandler;

  constructor(
    private readonly config: KafkaConsumerConfig,
    private readonly cls: ClsService<TraceStore>,
  ) {}

  registerHandler(handler: EnvelopeHandler): void {
    this.handler = handler;
  }

  async onModuleInit(): Promise<void> {
    this.kafka = new Kafka({
      clientId: this.config.clientId,
      brokers: this.config.brokers,
      retry: { retries: 8 },
    });
    this.consumer = this.kafka.consumer({ groupId: this.config.groupId });
    await this.consumer.connect();
    for (const topic of this.config.topics) {
      await this.consumer.subscribe({ topic, fromBeginning: false });
    }

    await this.consumer.run({
      eachMessage: async (payload) => {
        if (!this.handler) {
          this.logger.warn('No handler registered, dropping message');
          return;
        }
        const raw = payload.message.value?.toString() ?? '';
        try {
          const envelope = JSON.parse(raw) as EventEnvelope;
          const traceId = envelope.traceId ?? randomUUID();
          await this.cls.runWith({ traceId }, () =>
            this.handler!(envelope, payload),
          );
        } catch (err) {
          this.logger.error(
            `Failed to handle message from ${payload.topic}: ${(err as Error).message}`,
          );
          throw err;
        }
      },
    });

    this.logger.log(
      `Kafka consumer running (group=${this.config.groupId}, topics=${this.config.topics.join(',')})`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer?.disconnect();
  }
}
