import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { ClsService, ClsStore } from 'nestjs-cls';
import { TRACE_ID_KEY, withSpan } from '@app/common';
import { OrdersService } from './orders.service';

const RECOVERY_INTERVAL_MS = 15_000;

@Injectable()
export class SagaRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(SagaRecoveryService.name);

  constructor(
    private readonly orders: OrdersService,
    private readonly scheduler: SchedulerRegistry,
    private readonly cls: ClsService<ClsStore>,
  ) {}

  onModuleInit(): void {
    const handle = setInterval(() => {
      void this.cls.run(() =>
        withSpan('orders-saga-recovery', 'saga.recovery.tick', async (span) => {
          const traceId = randomUUID();
          this.cls.set(TRACE_ID_KEY, traceId);
          span.setAttribute('app.trace_id', traceId);
          try {
            const n = await this.orders.recoverStuckOrders();
            span.setAttribute('saga.recovered', n);
            if (n > 0) this.logger.log(`Recovered ${n} stuck orders`);
          } catch (err) {
            this.logger.error(
              `Saga recovery failed: ${(err as Error).message}`,
            );
          }
        }),
      );
    }, RECOVERY_INTERVAL_MS);
    this.scheduler.addInterval('orders-saga-recovery', handle);
  }
}
