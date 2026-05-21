import { ConfigifyModule } from '@itgorillaz/configify';
import { Module } from '@nestjs/common';
import { AppLoggerModule, PgModule, RedisModule } from '@app/common';
import { AppConfiguration } from './app.configuration';
import { HealthController } from './health.controller';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

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
    RedisModule.forRootAsync({
      inject: [AppConfiguration],
      useFactory: (cfg: AppConfiguration) => ({ url: cfg.redisUrl }),
    }),
  ],
  controllers: [HealthController, PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
