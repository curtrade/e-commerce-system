import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { OrdersModule } from './orders.module';
import { AppConfiguration } from './app.configuration';

async function bootstrap() {
  const app = await NestFactory.create(OrdersModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.enableCors();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();
  const cfg = app.get(AppConfiguration);
  await app.listen(cfg.port, '0.0.0.0');
  app.get(Logger).log(`orders listening on :${cfg.port}`, 'Bootstrap');
}
void bootstrap();
