import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { InventoryModule } from './inventory.module';
import { AppConfiguration } from './app.configuration';

async function bootstrap() {
  const app = await NestFactory.create(InventoryModule);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  app.enableShutdownHooks();
  const cfg = app.get(AppConfiguration);
  await app.listen(cfg.port, '0.0.0.0');
  new Logger('Bootstrap').log(`inventory listening on :${cfg.port}`);
}
void bootstrap();
