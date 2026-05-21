import { Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Request } from 'express';
import { ClsModule, ClsService, ClsStore } from 'nestjs-cls';

@Module({
  imports: [
    ClsModule.forRoot({
      global: true,                // ClsService доступен везде без импорта модуля
      middleware: {
        mount: true,               // автоматически вешает middleware на все роуты
        generateId: true,
        idGenerator: (req: Request) => {
          const header = req.headers['x-trace-id'];
          const traceId = Array.isArray(header) ? header[0] : header;
          return traceId ?? randomUUID();
        },
        setup: (cls: ClsService<ClsStore>, _req: Request) => {
          cls.set('traceId', cls.getId());
        },
      },
    }),
  ],
  exports: [ClsModule],
})
export class SharedClsModule {}
