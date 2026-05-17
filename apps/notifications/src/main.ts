import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NotificationsModule } from './notifications.module';
import { AppConfiguration } from './app.configuration';

async function bootstrap() {
  const app = await NestFactory.create(NotificationsModule);
  app.enableShutdownHooks();
  const cfg = app.get(AppConfiguration);
  await app.listen(cfg.port, '0.0.0.0');
  new Logger('Bootstrap').log(`notifications listening on :${cfg.port}`);
}
void bootstrap();
