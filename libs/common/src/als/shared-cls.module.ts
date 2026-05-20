import { Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ClsModule, ClsService } from 'nestjs-cls';
import { IncomingMessage } from 'node:http';
import { TraceStore } from './cls-store';

@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        setup: (cls: ClsService<TraceStore>, req: IncomingMessage) => {
          const header = req.headers['x-trace-id'];
          const traceId =
            (Array.isArray(header) ? header[0] : header) ?? randomUUID();
          cls.set('traceId', traceId);
        },
      },
    }),
  ],
  exports: [ClsModule],
})
export class SharedClsModule {}
