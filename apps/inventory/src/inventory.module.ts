import { ConfigifyModule } from '@itgorillaz/configify';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import {
  AppLoggerModule,
  KafkaConsumerService,
  PgModule,
  RedisModule,
  ORDERS_TOPIC,
} from '@app/common';
import { AppConfiguration } from './app.configuration';
import { HealthController } from './health.controller';
import { InventoryConsumer } from './inventory.consumer';
import { InventoryController } from './inventory.controller';
import { InventoryReaper } from './inventory.reaper';
import { InventoryService } from './inventory.service';
import { PrismaExceptionFilter } from './prisma/prisma-exception.filter';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    AppLoggerModule,
    ConfigifyModule.forRootAsync(),
    ScheduleModule.forRoot(),
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
  controllers: [HealthController, InventoryController],
  providers: [
    InventoryService,
    InventoryConsumer,
    InventoryReaper,
    {
      provide: APP_FILTER,
      useClass: PrismaExceptionFilter,
    },
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
