import { Module } from '@nestjs/common';

import { ConfigifyModule } from '@itgorillaz/configify';
import { HttpModule } from '@nestjs/axios';
import { ScheduleModule } from '@nestjs/schedule';
import { ClsService } from 'nestjs-cls';
import {
  KafkaProducerService,
  PgModule,
  RedisModule,
  SharedClsModule,
  TraceStore,
} from '@app/common';
import { AppConfiguration } from './app.configuration';
import { InventoryClient } from './clients/inventory.client';
import { PaymentsClient } from './clients/payments.client';
import { HealthController } from './health.controller';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OutboxPublisher } from './outbox.publisher';
import { SagaRecoveryService } from './saga-recovery.service';

@Module({
  imports: [
    SharedClsModule,
    ConfigifyModule.forRootAsync(),
    ScheduleModule.forRoot(),
    HttpModule,
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
  controllers: [HealthController, OrdersController],
  providers: [
    OrdersService,
    InventoryClient,
    PaymentsClient,
    OutboxPublisher,
    SagaRecoveryService,
    {
      provide: KafkaProducerService,
      inject: [AppConfiguration, ClsService],
      useFactory: (cfg: AppConfiguration, cls: ClsService<TraceStore>) =>
        new KafkaProducerService(
          {
            clientId: 'orders',
            brokers: cfg.kafkaBrokers.split(',').map((b) => b.trim()),
          },
          cls,
        ),
    },
  ],
})
export class OrdersModule {}
