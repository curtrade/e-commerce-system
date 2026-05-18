import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { OrdersService } from './orders.service';

const RECOVERY_INTERVAL_MS = 15_000;

@Injectable()
export class SagaRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(SagaRecoveryService.name);

  constructor(
    private readonly orders: OrdersService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const handle = setInterval(() => {
      this.orders
        .recoverStuckOrders()
        .then((n) => {
          if (n > 0) this.logger.log(`Recovered ${n} stuck orders`);
        })
        .catch((err) =>
          this.logger.error(`Saga recovery failed: ${(err as Error).message}`),
        );
    }, RECOVERY_INTERVAL_MS);
    this.scheduler.addInterval('orders-saga-recovery', handle);
  }
}
