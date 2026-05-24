import { ConfigifyModule } from '@itgorillaz/configify';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import {
  AppLoggerModule,
  KafkaConsumerService,
  ORDERS_TOPIC,
  PgModule,
  RedisModule,
} from '@app/common';
import { AppConfiguration } from './app.configuration';
import { HealthController } from './notifications.controller';
import { NotificationsConsumer } from './notifications.consumer';
import { NotificationsService } from './notifications.service';
import { PrismaExceptionFilter } from './prisma/prisma-exception.filter';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    AppLoggerModule,
    ConfigifyModule.forRootAsync(),
    PgModule.forRootAsync({
      inject: [AppConfiguration],
      useFactory: (cfg: AppConfiguration) => ({
        connectionString: cfg.databaseUrl,
      }),
    }),
    PrismaModule,
    RedisModule.forRootAsync({
      inject: [AppConfiguration],
      useFactory: (cfg: AppConfiguration) => ({ url: cfg.redisUrl }),
    }),
  ],
  controllers: [HealthController],
  providers: [
    NotificationsService,
    NotificationsConsumer,
    {
      provide: APP_FILTER,
      useClass: PrismaExceptionFilter,
    },
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
