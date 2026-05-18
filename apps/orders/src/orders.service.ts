import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService } from '@app/common';
import {
  ORDERS_TOPIC,
  OrderConfirmedPayload,
  OrderFailedPayload,
} from '@app/common';
import { AppConfiguration } from './app.configuration';
import { InventoryClient } from './clients/inventory.client';
import { PaymentsClient } from './clients/payments.client';
import { CreateOrderDto } from './dto/create-order.dto';

export type OrderStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'FAILED_INVENTORY'
  | 'FAILED_PAYMENT'
  | 'FAILED_TIMEOUT'
  | 'REFUNDED';

export interface OrderRow {
  id: string;
  customer_id: string;
  email: string;
  items: unknown;
  total: string;
  status: OrderStatus;
  reservation_id: string | null;
  payment_id: string | null;
  attempt_id: string;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly pg: PgService,
    private readonly inventory: InventoryClient,
    private readonly payments: PaymentsClient,
    private readonly cfg: AppConfiguration,
  ) {}

  async createOrder(dto: CreateOrderDto) {
    const orderId = randomUUID();
    const attemptId = randomUUID();
    const total = dto.items.reduce(
      (sum, it) => sum + it.qty * it.unitPrice,
      0,
    );

    await this.pg.query(
      `INSERT INTO orders (id, customer_id, email, items, total, status, attempt_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'PENDING', $6)`,
      [orderId, dto.customerId, dto.email, JSON.stringify(dto.items), total, attemptId],
    );

    const idemKey = `${orderId}:${attemptId}`;

    let reservationId: string;
    try {
      const res = await this.inventory.reserve({
        orderId,
        idempotencyKey: idemKey,
        items: dto.items,
        ttlSec: this.cfg.reservationTtlSec,
      });
      reservationId = res.reservationId;
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.warn(`Inventory.reserve failed for ${orderId}: ${reason}`);
      await this.failOrder(orderId, 'FAILED_INVENTORY', reason, null);
      return { orderId, status: 'FAILED_INVENTORY', reason };
    }

    let paymentId: string;
    try {
      const res = await this.payments.charge({
        orderId,
        amount: total,
        idempotencyKey: idemKey,
      });
      paymentId = res.paymentId;
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.warn(`Payments.charge failed for ${orderId}: ${reason}`);

      // Layer 2 of compensation — explicit release. TTL on the reservation is
      // the safety net if this call also fails (handled by inventory side).
      await this.inventory.release({
        reservationId,
        idempotencyKey: `${idemKey}:release`,
      });
      await this.failOrder(orderId, 'FAILED_PAYMENT', reason, reservationId);
      return { orderId, status: 'FAILED_PAYMENT', reason };
    }

    // Atomic: mark CONFIRMED + outbox event in one tx.
    await this.pg.withTransaction(async (client) => {
      await client.query(
        `UPDATE orders
            SET status = 'CONFIRMED',
                reservation_id = $2,
                payment_id = $3,
                updated_at = NOW()
          WHERE id = $1`,
        [orderId, reservationId, paymentId],
      );

      const payload: OrderConfirmedPayload = {
        orderId,
        reservationId,
        paymentId,
        customerId: dto.customerId,
        email: dto.email,
        items: dto.items,
        total,
      };

      await client.query(
        `INSERT INTO orders_outbox (id, aggregate_id, topic, event_type, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          randomUUID(),
          orderId,
          ORDERS_TOPIC,
          'OrderConfirmed',
          JSON.stringify(payload),
        ],
      );
    });

    return {
      orderId,
      status: 'CONFIRMED',
      reservationId,
      paymentId,
      total,
    };
  }

  private async failOrder(
    orderId: string,
    status: 'FAILED_INVENTORY' | 'FAILED_PAYMENT' | 'FAILED_TIMEOUT',
    reason: string,
    reservationId: string | null,
  ): Promise<void> {
    await this.pg.withTransaction(async (client) => {
      await client.query(
        `UPDATE orders
            SET status = $2, error = $3, reservation_id = COALESCE(reservation_id, $4), updated_at = NOW()
          WHERE id = $1`,
        [orderId, status, reason, reservationId],
      );

      // Layer 3: durable compensation event. Inventory consumer is idempotent
      // by reservationId, so even if explicit release succeeded, the duplicate
      // is a no-op.
      const payload: OrderFailedPayload = {
        orderId,
        reservationId: reservationId ?? undefined,
        reason,
      };
      await client.query(
        `INSERT INTO orders_outbox (id, aggregate_id, topic, event_type, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          randomUUID(),
          orderId,
          ORDERS_TOPIC,
          'OrderFailed',
          JSON.stringify(payload),
        ],
      );
    });
  }

  async getOrder(orderId: string) {
    const { rows } = await this.pg.query<OrderRow>(
      `SELECT * FROM orders WHERE id = $1`,
      [orderId],
    );
    return rows[0] ?? null;
  }

  /** Saga recovery: orders stuck in PENDING beyond timeout get terminalized. */
  async recoverStuckOrders(): Promise<number> {
    const { rows } = await this.pg.query<{
      id: string;
      reservation_id: string | null;
    }>(
      `SELECT id, reservation_id
         FROM orders
        WHERE status = 'PENDING'
          AND created_at < NOW() - ($1 || ' seconds')::interval
        LIMIT 50`,
      [this.cfg.sagaTimeoutSec],
    );
    for (const row of rows) {
      this.logger.warn(`Recovering stuck order ${row.id} → FAILED_TIMEOUT`);
      await this.failOrder(
        row.id,
        'FAILED_TIMEOUT',
        'saga recovery: PENDING beyond timeout',
        row.reservation_id,
      );
    }
    return rows.length;
  }
}
