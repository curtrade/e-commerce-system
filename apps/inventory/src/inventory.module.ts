import { ConfigifyModule } from '@itgorillaz/configify';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ClsService, ClsStore } from 'nestjs-cls';
import {
  KafkaConsumerService,
  PgModule,
  RedisModule,
  SharedClsModule,
  ORDERS_TOPIC,
} from '@app/common';
import { AppConfiguration } from './app.configuration';
import { HealthController } from './health.controller';
import { InventoryConsumer } from './inventory.consumer';
import { InventoryController } from './inventory.controller';
import { InventoryReaper } from './inventory.reaper';
import { InventoryService } from './inventory.service';

@Module({
  imports: [
    SharedClsModule,
    ConfigifyModule.forRootAsync(),
    ScheduleModule.forRoot(),
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
    InventoryService,
    InventoryConsumer,
    InventoryReaper,
    {
      provide: KafkaConsumerService,
      inject: [AppConfiguration, ClsService],
      useFactory: (cfg: AppConfiguration, cls: ClsService<ClsStore>) =>
        new KafkaConsumerService(
          {
            clientId: 'inventory',
            brokers: cfg.kafkaBrokers.split(',').map((b) => b.trim()),
            groupId: 'inventory-orders',
            topics: [ORDERS_TOPIC],
          },
          cls,
        ),
    },
  ],
})
export class InventoryModule {}
