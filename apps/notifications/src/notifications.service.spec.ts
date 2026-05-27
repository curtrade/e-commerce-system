import { NotificationsService } from './notifications.service';
import { AppConfiguration } from './app.configuration';
import { createMockPg, pgResult } from '../../../test/helpers/mock-factories';

function setup() {
  const pg = createMockPg();
  const cfg = { senderEmail: 'noreply@test' } as AppConfiguration;
  const service = new NotificationsService(pg.service, cfg);
  return { service, pg, cfg };
}

describe('NotificationsService', () => {
  describe('sendOrderConfirmedEmail', () => {
    it('inserts notification row with email channel and confirmation subject/body', async () => {
      const s = setup();
      s.pg.query.mockResolvedValueOnce(pgResult());

      await s.service.sendOrderConfirmedEmail({
        orderId: 'o-1',
        email: 'buyer@example.com',
        total: 42.5,
      });

      expect(s.pg.query).toHaveBeenCalledTimes(1);
      const [sql, params] = s.pg.query.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO notifications/);
      expect(sql).toMatch(/'email'/);
      expect(sql).toMatch(/'Order confirmed'/);
      expect(params).toEqual([
        'o-1',
        'buyer@example.com',
        'Your order o-1 for $42.5 is confirmed.',
      ]);
    });
  });

  describe('sendOrderFailedEmail', () => {
    it('without email: no row inserted (early return)', async () => {
      const s = setup();

      await s.service.sendOrderFailedEmail({
        orderId: 'o-2',
        email: undefined,
        reason: 'card declined',
      });

      expect(s.pg.query).not.toHaveBeenCalled();
    });

    it('with email: inserts notification row with failure subject and reason in body', async () => {
      const s = setup();
      s.pg.query.mockResolvedValueOnce(pgResult());

      await s.service.sendOrderFailedEmail({
        orderId: 'o-3',
        email: 'buyer@example.com',
        reason: 'card declined',
      });

      const [sql, params] = s.pg.query.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO notifications/);
      expect(sql).toMatch(/'Order failed'/);
      expect(params).toEqual([
        'o-3',
        'buyer@example.com',
        'Order o-3 failed: card declined',
      ]);
    });
  });
});
