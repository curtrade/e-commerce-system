import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { AppConfiguration } from '../app.configuration';
import { OrderItemDto } from '../dto/create-order.dto';

export interface ReserveResponse {
  reservationId: string;
  expiresAt: string;
}

@Injectable()
export class InventoryClient {
  private readonly logger = new Logger(InventoryClient.name);

  constructor(
    private readonly http: HttpService,
    private readonly cfg: AppConfiguration,
  ) {}

  async reserve(args: {
    orderId: string;
    idempotencyKey: string;
    items: OrderItemDto[];
    ttlSec: number;
  }): Promise<ReserveResponse> {
    const url = `${this.cfg.inventoryUrl}/inventory/reserve`;
    const { data } = await firstValueFrom(
      this.http.post<ReserveResponse>(
        url,
        {
          orderId: args.orderId,
          items: args.items,
          ttlSec: args.ttlSec,
        },
        {
          headers: { 'Idempotency-Key': args.idempotencyKey },
          timeout: 5000,
        },
      ),
    );
    return data;
  }

  async release(args: {
    reservationId: string;
    idempotencyKey: string;
  }): Promise<void> {
    const url = `${this.cfg.inventoryUrl}/inventory/release`;
    try {
      await firstValueFrom(
        this.http.post(
          url,
          { reservationId: args.reservationId },
          {
            headers: { 'Idempotency-Key': args.idempotencyKey },
            timeout: 5000,
          },
        ),
      );
    } catch (err) {
      this.logger.warn(
        `Inventory.release failed for ${args.reservationId}: ${(err as Error).message} — will rely on outbox compensation`,
      );
    }
  }
}
