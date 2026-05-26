import { bootstrapService } from '@app/common';
import { Logger } from 'nestjs-pino';
import { AppConfiguration } from './app.configuration';
import { PaymentsModule } from './payments.module';

async function bootstrap() {
  const app = await bootstrapService(PaymentsModule, {
    swagger: {
      title: 'Payments Service',
      description: 'Идемпотентный charge/refund с Redis-кэшем и ON CONFLICT',
    },
  });
  const cfg = app.get(AppConfiguration);
  await app.listen(cfg.port, '0.0.0.0');
  app.get(Logger).log(`payments listening on :${cfg.port}`, 'Bootstrap');
}
void bootstrap();
