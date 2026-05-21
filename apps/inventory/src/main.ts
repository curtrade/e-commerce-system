import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { InventoryModule } from './inventory.module';
import { AppConfiguration } from './app.configuration';

async function bootstrap() {
  const app = await NestFactory.create(InventoryModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();
  const cfg = app.get(AppConfiguration);
  await app.listen(cfg.port, '0.0.0.0');
  app.get(Logger).log(`inventory listening on :${cfg.port}`, 'Bootstrap');
}
void bootstrap();
