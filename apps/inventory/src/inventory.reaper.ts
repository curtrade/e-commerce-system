import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InventoryService } from './inventory.service';

const REAP_INTERVAL_MS = 30_000;

@Injectable()
export class InventoryReaper implements OnModuleInit {
  private readonly logger = new Logger(InventoryReaper.name);

  constructor(
    private readonly inventory: InventoryService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const handle = setInterval(() => {
      this.inventory
        .expirePending()
        .then((n) => {
          if (n > 0) this.logger.log(`Expired ${n} stale reservations`);
        })
        .catch((err) =>
          this.logger.error(`Reaper failed: ${(err as Error).message}`),
        );
    }, REAP_INTERVAL_MS);
    this.scheduler.addInterval('inventory-ttl-reaper', handle);
  }
}
