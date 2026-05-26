import { ValidationPipe } from '@nestjs/common';
import type { INestApplication, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

export interface BootstrapOptions {
  swagger?: { title: string; description: string };
}

export async function bootstrapService(
  module: Type<unknown>,
  opts?: BootstrapOptions,
): Promise<INestApplication> {
  const app = await NestFactory.create(module, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(helmet());

  if (process.env.ALLOWED_ORIGINS) {
    app.enableCors({
      origin: process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()),
    });
  }

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  if (opts?.swagger && process.env.NODE_ENV !== 'production') {
    const doc = new DocumentBuilder()
      .setTitle(opts.swagger.title)
      .setDescription(opts.swagger.description)
      .setVersion('1.0')
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc));
  }

  app.enableShutdownHooks();
  return app;
}
