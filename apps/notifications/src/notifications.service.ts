import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '@app/common';
import { AppConfiguration } from './app.configuration';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly pg: PgService,
    private readonly cfg: AppConfiguration,
  ) {}

  async sendOrderConfirmedEmail(args: {
    orderId: string;
    email: string;
    total: number;
  }): Promise<void> {
    // Naive: log + persist. Real impl would push to SMTP / SES / push provider.
    this.logger.log(
      `[email→${args.email}] from ${this.cfg.senderEmail}: order ${args.orderId} confirmed (total=${args.total})`,
    );
    await this.pg.query(
      `INSERT INTO notifications (order_id, channel, recipient, subject, body)
       VALUES ($1, 'email', $2, 'Order confirmed', $3)`,
      [
        args.orderId,
        args.email,
        `Your order ${args.orderId} for $${args.total} is confirmed.`,
      ],
    );
  }

  async sendOrderFailedEmail(args: {
    orderId: string;
    email?: string;
    reason: string;
  }): Promise<void> {
    if (!args.email) return;
    this.logger.log(
      `[email→${args.email}] order ${args.orderId} failed: ${args.reason}`,
    );
    await this.pg.query(
      `INSERT INTO notifications (order_id, channel, recipient, subject, body)
       VALUES ($1, 'email', $2, 'Order failed', $3)`,
      [
        args.orderId,
        args.email,
        `Order ${args.orderId} failed: ${args.reason}`,
      ],
    );
  }
}
