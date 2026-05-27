import { ConfigifyModule } from '@itgorillaz/configify';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import {
  AppLoggerModule,
  KafkaConsumerService,
  ORDERS_TOPIC,
  PgModule,
  RedisModule,
} from '@app/common';
import { AppConfiguration } from './app.configuration';
import { HealthController, SERVICE_NAME } from './notifications.controller';
import { NotificationsConsumer } from './notifications.consumer';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [
    AppLoggerModule,
    ConfigifyModule.forRootAsync(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    PgModule.forRootAsync({
      inject: [AppConfiguration],
      useFactory: (cfg: AppConfiguration) => ({
        connectionString: cfg.databaseUrl,
      }),
    }),
    RedisModule.forRootAsync({
      inject: [AppConfiguration],
      useFactory: (cfg: AppConfiguration) => ({ url: cfg.redisUrl }),
    }),
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: SERVICE_NAME, useValue: 'notifications' },
    NotificationsService,
    NotificationsConsumer,
    {
      provide: KafkaConsumerService,
      inject: [AppConfiguration],
      useFactory: (cfg: AppConfiguration) =>
        new KafkaConsumerService({
          clientId: 'notifications',
          brokers: cfg.kafkaBrokers.split(',').map((b) => b.trim()),
          groupId: 'notifications-orders',
          topics: [ORDERS_TOPIC],
        }),
    },
  ],
})
export class NotificationsModule {}
