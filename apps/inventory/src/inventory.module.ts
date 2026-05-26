import { ConfigifyModule } from '@itgorillaz/configify';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import {
  AppLoggerModule,
  KafkaConsumerService,
  PgModule,
  RedisModule,
  ORDERS_TOPIC,
} from '@app/common';
import { AppConfiguration } from './app.configuration';
import { HealthController, SERVICE_NAME } from './health.controller';
import { InventoryConsumer } from './inventory.consumer';
import { InventoryController } from './inventory.controller';
import { InventoryReaper } from './inventory.reaper';
import { InventoryService } from './inventory.service';

@Module({
  imports: [
    AppLoggerModule,
    ConfigifyModule.forRootAsync(),
    ScheduleModule.forRoot(),
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
  controllers: [HealthController, InventoryController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: SERVICE_NAME, useValue: 'inventory' },
    InventoryService,
    InventoryConsumer,
    InventoryReaper,
    {
      provide: KafkaConsumerService,
      inject: [AppConfiguration],
      useFactory: (cfg: AppConfiguration) =>
        new KafkaConsumerService({
          clientId: 'inventory',
          brokers: cfg.kafkaBrokers.split(',').map((b) => b.trim()),
          groupId: 'inventory-orders',
          topics: [ORDERS_TOPIC],
        }),
    },
  ],
})
export class InventoryModule {}
