import type { EachMessagePayload } from 'kafkajs';
import {
  EnvelopeHandler,
  EventEnvelope,
  KafkaConsumerService,
  OrderConfirmedPayload,
  OrderFailedPayload,
} from '@app/common';
import { NotificationsConsumer } from './notifications.consumer';
import { NotificationsService } from './notifications.service';
import { createMockRedis } from '../../../test/helpers/mock-factories';

const FAKE_RAW = {} as EachMessagePayload;

function setup() {
  let registeredHandler: EnvelopeHandler | undefined;
  const consumer = {
    registerHandler: jest.fn((h: EnvelopeHandler) => {
      registeredHandler = h;
    }),
  } as unknown as KafkaConsumerService;
  const notifications = {
    sendOrderConfirmedEmail: jest.fn().mockResolvedValue(undefined),
    sendOrderFailedEmail: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<NotificationsService>;
  const redis = createMockRedis();
  new NotificationsConsumer(consumer, notifications, redis.service);

  if (!registeredHandler) throw new Error('handler not registered');
  const handle = (env: EventEnvelope) => registeredHandler!(env, FAKE_RAW);
  return { handle, notifications, redis };
}

function envelope<T>(
  eventType: string,
  payload: T,
  eventId = 'ev-1',
): EventEnvelope<T> {
  return { eventId, eventType, occurredAt: '2026-01-01T00:00:00Z', payload };
}

describe('NotificationsConsumer', () => {
  it('skips duplicate events (claimIdempotency=false)', async () => {
    const s = setup();
    s.redis.claimIdempotency.mockResolvedValueOnce(false);

    await s.handle(
      envelope<OrderConfirmedPayload>('OrderConfirmed', {
        orderId: 'o-1',
        reservationId: 'r',
        paymentId: 'p',
        customerId: 'c',
        email: 'e@e',
        items: [],
        total: 1,
      }),
    );

    expect(s.redis.claimIdempotency).toHaveBeenCalledWith(
      'notify:consumed:ev-1',
      7 * 24 * 60 * 60,
    );
    expect(s.notifications.sendOrderConfirmedEmail).not.toHaveBeenCalled();
    expect(s.notifications.sendOrderFailedEmail).not.toHaveBeenCalled();
  });

  it('OrderConfirmed → calls sendOrderConfirmedEmail with payload fields', async () => {
    const s = setup();
    s.redis.claimIdempotency.mockResolvedValueOnce(true);

    await s.handle(
      envelope<OrderConfirmedPayload>('OrderConfirmed', {
        orderId: 'o-42',
        reservationId: 'r',
        paymentId: 'p',
        customerId: 'c',
        email: 'buyer@example.com',
        items: [],
        total: 99.9,
      }),
    );

    expect(s.notifications.sendOrderConfirmedEmail).toHaveBeenCalledWith({
      orderId: 'o-42',
      email: 'buyer@example.com',
      total: 99.9,
    });
    expect(s.notifications.sendOrderFailedEmail).not.toHaveBeenCalled();
  });

  it('OrderFailed → calls sendOrderFailedEmail (email may be missing)', async () => {
    const s = setup();
    s.redis.claimIdempotency.mockResolvedValueOnce(true);

    await s.handle(
      envelope<OrderFailedPayload & { email?: string }>('OrderFailed', {
        orderId: 'o-7',
        reservationId: 'r-7',
        reason: 'card declined',
        email: 'buyer@example.com',
      }),
    );

    expect(s.notifications.sendOrderFailedEmail).toHaveBeenCalledWith({
      orderId: 'o-7',
      email: 'buyer@example.com',
      reason: 'card declined',
    });
  });

  it('unknown event type → no service call', async () => {
    const s = setup();
    s.redis.claimIdempotency.mockResolvedValueOnce(true);

    await s.handle(envelope('SomeOtherEvent', { foo: 'bar' }));

    expect(s.notifications.sendOrderConfirmedEmail).not.toHaveBeenCalled();
    expect(s.notifications.sendOrderFailedEmail).not.toHaveBeenCalled();
  });
});
