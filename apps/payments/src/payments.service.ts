import {
  BadGatewayException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService, RedisService } from '@app/common';
import { AppConfiguration } from './app.configuration';
import { ChargeDto, RefundDto } from './dto/charge.dto';

const IDEMPOTENCY_TTL_SEC = 24 * 60 * 60;

export interface PaymentRow {
  id: string;
  order_id: string;
  amount: string;
  status: 'CHARGED' | 'REFUNDED' | 'FAILED';
  idempotency_key: string;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly pg: PgService,
    private readonly redis: RedisService,
    private readonly cfg: AppConfiguration,
  ) {}

  async charge(
    dto: ChargeDto,
    idemKey: string,
  ): Promise<{ paymentId: string; status: 'CHARGED' }> {
    const cached = await this.redis
      .raw()
      .get(`pay:idem:${idemKey}`);
    if (cached) {
      return JSON.parse(cached) as { paymentId: string; status: 'CHARGED' };
    }

    if (Math.random() < this.cfg.failureRate) {
      throw new BadGatewayException('Simulated payment provider failure');
    }

    const paymentId = randomUUID();
    await this.pg.query(
      `INSERT INTO payments (id, order_id, amount, status, idempotency_key)
       VALUES ($1, $2, $3, 'CHARGED', $4)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [paymentId, dto.orderId, dto.amount, idemKey],
    );

    // Re-read in case ON CONFLICT skipped insert (concurrent identical request).
    const { rows } = await this.pg.query<PaymentRow>(
      `SELECT id, status FROM payments WHERE idempotency_key = $1`,
      [idemKey],
    );
    const row = rows[0];
    if (!row) throw new BadGatewayException('Failed to persist payment');

    const result = { paymentId: row.id, status: 'CHARGED' as const };
    await this.redis
      .raw()
      .set(
        `pay:idem:${idemKey}`,
        JSON.stringify(result),
        'EX',
        IDEMPOTENCY_TTL_SEC,
      );
    return result;
  }

  async refund(dto: RefundDto): Promise<{ status: string }> {
    const { rows } = await this.pg.query<PaymentRow>(
      `SELECT * FROM payments WHERE id = $1 FOR UPDATE`,
      [dto.paymentId],
    );
    const r = rows[0];
    if (!r) throw new NotFoundException('Payment not found');
    if (r.status === 'REFUNDED') return { status: 'REFUNDED' };
    if (r.status !== 'CHARGED') {
      throw new BadGatewayException(`Cannot refund payment in ${r.status}`);
    }
    await this.pg.query(
      `UPDATE payments SET status = 'REFUNDED', updated_at = NOW() WHERE id = $1`,
      [dto.paymentId],
    );
    this.logger.log(`Refunded ${dto.paymentId}: ${dto.reason}`);
    return { status: 'REFUNDED' };
  }

  async getByOrder(orderId: string): Promise<PaymentRow | null> {
    const { rows } = await this.pg.query<PaymentRow>(
      `SELECT * FROM payments WHERE order_id = $1`,
      [orderId],
    );
    return rows[0] ?? null;
  }
}
