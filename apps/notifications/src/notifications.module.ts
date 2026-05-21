import { ConfigifyModule } from '@itgorillaz/configify';
import { Module } from '@nestjs/common';
import { ClsService, ClsStore } from 'nestjs-cls';
import {
  KafkaConsumerService,
  ORDERS_TOPIC,
  PgModule,
  RedisModule,
  SharedClsModule,
} from '@app/common';
import { AppConfiguration } from './app.configuration';
import { HealthController } from './notifications.controller';
import { NotificationsConsumer } from './notifications.consumer';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [
    SharedClsModule,
    ConfigifyModule.forRootAsync(),
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
    NotificationsService,
    NotificationsConsumer,
    {
      provide: KafkaConsumerService,
      inject: [AppConfiguration, ClsService],
      useFactory: (cfg: AppConfiguration, cls: ClsService<ClsStore>) =>
        new KafkaConsumerService(
          {
            clientId: 'notifications',
            brokers: cfg.kafkaBrokers.split(',').map((b) => b.trim()),
            groupId: 'notifications-orders',
            topics: [ORDERS_TOPIC],
          },
          cls,
        ),
    },
  ],
})
export class NotificationsModule {}
