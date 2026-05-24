import { ConfigifyModule } from '@itgorillaz/configify';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppLoggerModule, PgModule, RedisModule } from '@app/common';
import { AppConfiguration } from './app.configuration';
import { HealthController } from './health.controller';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
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
  controllers: [HealthController, PaymentsController],
  providers: [
    PaymentsService,
    {
      provide: APP_FILTER,
      useClass: PrismaExceptionFilter,
    },
  ],
})
export class PaymentsModule {}
