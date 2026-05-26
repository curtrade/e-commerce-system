import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { NotificationsModule } from './notifications.module';
import { AppConfiguration } from './app.configuration';

async function bootstrap() {
  const app = await NestFactory.create(NotificationsModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.enableCors();
  app.enableShutdownHooks();
  const cfg = app.get(AppConfiguration);
  await app.listen(cfg.port, '0.0.0.0');
  app.get(Logger).log(`notifications listening on :${cfg.port}`, 'Bootstrap');
}
void bootstrap();
