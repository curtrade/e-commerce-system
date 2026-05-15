import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService, RedisService } from '@app/common';
import {
  CommitDto,
  InventoryItemDto,
  ReleaseDto,
  ReserveDto,
} from './dto/reserve.dto';

export interface ReservationRow {
  id: string;
  order_id: string;
  items: InventoryItemDto[];
  status: 'PENDING' | 'COMMITTED' | 'RELEASED' | 'EXPIRED';
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

const IDEMPOTENCY_TTL_SEC = 24 * 60 * 60;

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly pg: PgService,
    private readonly redis: RedisService,
  ) {}

  async reserve(
    dto: ReserveDto,
    idempotencyKey: string,
  ): Promise<{ reservationId: string; expiresAt: string }> {
    const cached = await this.lookupIdempotent(idempotencyKey);
    if (cached) return cached;

    return this.pg.withTransaction(async (client) => {
      // Sort to avoid deadlock when two reservations hit overlapping SKUs.
      const sorted = [...dto.items].sort((a, b) => a.sku.localeCompare(b.sku));

      for (const item of sorted) {
        const { rowCount } = await client.query(
          `UPDATE inventory_items
              SET available = available - $2,
                  reserved = reserved + $2,
                  updated_at = NOW()
            WHERE sku = $1 AND available >= $2`,
          [item.sku, item.qty],
        );
        if (rowCount === 0) {
          throw new ConflictException(
            `Insufficient stock for SKU ${item.sku}`,
          );
        }
      }

      const reservationId = randomUUID();
      const expiresAt = new Date(Date.now() + dto.ttlSec * 1000);
      await client.query(
        `INSERT INTO reservations (id, order_id, items, status, expires_at)
         VALUES ($1, $2, $3::jsonb, 'PENDING', $4)`,
        [reservationId, dto.orderId, JSON.stringify(sorted), expiresAt],
      );

      const result = { reservationId, expiresAt: expiresAt.toISOString() };
      await this.storeIdempotent(idempotencyKey, result);
      return result;
    });
  }

  async release(dto: ReleaseDto): Promise<{ status: string }> {
    return this.pg.withTransaction(async (client) => {
      const { rows } = await client.query<ReservationRow>(
        `SELECT * FROM reservations WHERE id = $1 FOR UPDATE`,
        [dto.reservationId],
      );
      const r = rows[0];
      if (!r) throw new NotFoundException('Reservation not found');

      if (r.status !== 'PENDING') {
        // Idempotent: COMMITTED / RELEASED / EXPIRED — no-op.
        return { status: r.status };
      }

      for (const item of r.items) {
        await client.query(
          `UPDATE inventory_items
              SET available = available + $2,
                  reserved = reserved - $2,
                  updated_at = NOW()
            WHERE sku = $1`,
          [item.sku, item.qty],
        );
      }
      await client.query(
        `UPDATE reservations SET status = 'RELEASED', updated_at = NOW() WHERE id = $1`,
        [dto.reservationId],
      );
      return { status: 'RELEASED' };
    });
  }

  async commit(dto: CommitDto): Promise<{ status: string }> {
    return this.pg.withTransaction(async (client) => {
      const { rows } = await client.query<ReservationRow>(
        `SELECT * FROM reservations WHERE id = $1 FOR UPDATE`,
        [dto.reservationId],
      );
      const r = rows[0];
      if (!r) throw new NotFoundException('Reservation not found');

      if (r.status === 'COMMITTED') return { status: 'COMMITTED' };
      if (r.status !== 'PENDING') {
        throw new ConflictException(
          `Cannot commit reservation in status ${r.status}`,
        );
      }

      for (const item of r.items) {
        await client.query(
          `UPDATE inventory_items
              SET reserved = reserved - $2,
                  sold = sold + $2,
                  updated_at = NOW()
            WHERE sku = $1`,
          [item.sku, item.qty],
        );
      }
      await client.query(
        `UPDATE reservations SET status = 'COMMITTED', updated_at = NOW() WHERE id = $1`,
        [dto.reservationId],
      );
      return { status: 'COMMITTED' };
    });
  }

  /** Reaper for TTL: PENDING reservations past expires_at → released. Safety net. */
  async expirePending(): Promise<number> {
    const { rows } = await this.pg.query<{ id: string }>(
      `SELECT id FROM reservations
        WHERE status = 'PENDING' AND expires_at < NOW()
        LIMIT 100`,
    );
    let n = 0;
    for (const row of rows) {
      try {
        await this.release({ reservationId: row.id });
        n++;
      } catch (err) {
        this.logger.error(
          `Failed to expire reservation ${row.id}: ${(err as Error).message}`,
        );
      }
    }
    return n;
  }

  private async lookupIdempotent(
    key: string,
  ): Promise<{ reservationId: string; expiresAt: string } | null> {
    const raw = await this.redis.raw().get(`inv:idem:${key}`);
    return raw ? (JSON.parse(raw) as { reservationId: string; expiresAt: string }) : null;
  }

  private async storeIdempotent(
    key: string,
    value: { reservationId: string; expiresAt: string },
  ): Promise<void> {
    await this.redis
      .raw()
      .set(`inv:idem:${key}`, JSON.stringify(value), 'EX', IDEMPOTENCY_TTL_SEC);
  }
}
