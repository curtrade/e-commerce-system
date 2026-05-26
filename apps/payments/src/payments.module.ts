import { ConfigifyModule } from '@itgorillaz/configify';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppLoggerModule, PgModule, RedisModule } from '@app/common';
import { AppConfiguration } from './app.configuration';
import { HealthController, SERVICE_NAME } from './health.controller';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

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
  controllers: [HealthController, PaymentsController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: SERVICE_NAME, useValue: 'payments' },
    PaymentsService,
  ],
})
export class PaymentsModule {}
