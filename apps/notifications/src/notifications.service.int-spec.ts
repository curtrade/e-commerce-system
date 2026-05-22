import { PgService } from '@app/common';
import { NotificationsService } from './notifications.service';
import { AppConfiguration } from './app.configuration';
import { createTestPg } from '../../../test/helpers/pg-test';
import { truncateNotifications } from '../../../test/helpers/truncate';

interface NotificationRow {
  order_id: string;
  channel: string;
  recipient: string;
  subject: string;
  body: string;
}

describe('NotificationsService (integration)', () => {
  let pg: PgService;
  let svc: NotificationsService;
  const cfg = { senderEmail: 'noreply@test' } as AppConfiguration;

  beforeAll(() => {
    pg = createTestPg('notifications');
  });

  afterAll(async () => {
    await pg.onApplicationShutdown();
  });

  beforeEach(async () => {
    await truncateNotifications(pg);
    svc = new NotificationsService(pg, cfg);
  });

  it('sendOrderConfirmedEmail inserts a row with the confirmation subject and body', async () => {
    await svc.sendOrderConfirmedEmail({
      orderId: 'o-1',
      email: 'buyer@example.com',
      total: 17.25,
    });

    const { rows } = await pg.query<NotificationRow>(
      'SELECT order_id, channel, recipient, subject, body FROM notifications',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      order_id: 'o-1',
      channel: 'email',
      recipient: 'buyer@example.com',
      subject: 'Order confirmed',
    });
    expect(rows[0].body).toBe('Your order o-1 for $17.25 is confirmed.');
  });

  it('sendOrderFailedEmail inserts a row with the failure subject and reason', async () => {
    await svc.sendOrderFailedEmail({
      orderId: 'o-2',
      email: 'buyer@example.com',
      reason: 'card declined',
    });

    const { rows } = await pg.query<NotificationRow>(
      'SELECT order_id, subject, body FROM notifications',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      order_id: 'o-2',
      subject: 'Order failed',
    });
    expect(rows[0].body).toBe('Order o-2 failed: card declined');
  });

  it('sendOrderFailedEmail with no email skips persistence', async () => {
    await svc.sendOrderFailedEmail({
      orderId: 'o-3',
      email: undefined,
      reason: 'card declined',
    });

    const { rowCount } = await pg.query('SELECT 1 FROM notifications');
    expect(rowCount).toBe(0);
  });
});
