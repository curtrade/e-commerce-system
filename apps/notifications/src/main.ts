import { bootstrapService } from '@app/common';
import { Logger } from 'nestjs-pino';
import { AppConfiguration } from './app.configuration';
import { NotificationsModule } from './notifications.module';

async function bootstrap() {
  const app = await bootstrapService(NotificationsModule);
  const cfg = app.get(AppConfiguration);
  await app.listen(cfg.port, '0.0.0.0');
  app.get(Logger).log(`notifications listening on :${cfg.port}`, 'Bootstrap');
}
void bootstrap();
