import { Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import { Request } from 'express';
import { ClsModule, ClsService, ClsStore } from 'nestjs-cls';
import { TRACE_ID_KEY } from './trace-context';

@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        // mount=true вешает middleware на все HTTP-роуты.
        // Для Kafka-консьюмеров CLS-контекст поднимается вручную в KafkaConsumerService.
        mount: true,
        generateId: true,
        idGenerator: (req: Request) => {
          const header = req.headers['x-trace-id'];
          const traceId = Array.isArray(header) ? header[0] : header;
          return traceId ?? randomUUID();
        },
        setup: (cls: ClsService<ClsStore>, _req: Request) => {
          const id = cls.getId();
          cls.set(TRACE_ID_KEY, id);
          // Exposes the app-level traceId on the HTTP span so Jaeger can search by it.
          trace.getActiveSpan()?.setAttribute('app.trace_id', id);
        },
      },
    }),
  ],
  // ClsModule помечен global: true — экспорт нужен только чтобы потребители
  // могли подключить SharedClsModule в imports и тем самым активировать middleware.
  exports: [ClsModule],
})
export class SharedClsModule {}
