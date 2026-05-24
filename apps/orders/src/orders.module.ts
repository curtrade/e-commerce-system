import { ConfigifyModule } from '@itgorillaz/configify';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import {
  AppLoggerModule,
  KafkaProducerService,
  PgModule,
  RedisModule,
} from '@app/common';
import { AppConfiguration } from './app.configuration';
import { InventoryClient } from './clients/inventory.client';
import { PaymentsClient } from './clients/payments.client';
import { HealthController } from './health.controller';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OutboxPublisher } from './outbox.publisher';
import { PrismaExceptionFilter } from './prisma/prisma-exception.filter';
import { PrismaModule } from './prisma/prisma.module';
import { SagaRecoveryService } from './saga-recovery.service';

@Module({
  imports: [
    AppLoggerModule,
    ConfigifyModule.forRootAsync(),
    ScheduleModule.forRoot(),
    HttpModule,
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
  controllers: [HealthController, OrdersController],
  providers: [
    OrdersService,
    InventoryClient,
    PaymentsClient,
    OutboxPublisher,
    SagaRecoveryService,
    {
      provide: APP_FILTER,
      useClass: PrismaExceptionFilter,
    },
    {
      provide: KafkaProducerService,
      inject: [AppConfiguration],
      useFactory: (cfg: AppConfiguration) =>
        new KafkaProducerService({
          clientId: 'orders',
          brokers: cfg.kafkaBrokers.split(',').map((b) => b.trim()),
        }),
    },
  ],
})
export class OrdersModule {}
