import type { EachMessagePayload } from 'kafkajs';
import {
  EnvelopeHandler,
  EventEnvelope,
  KafkaConsumerService,
  OrderConfirmedPayload,
  OrderFailedPayload,
} from '@app/common';
import { InventoryConsumer } from './inventory.consumer';
import { InventoryService } from './inventory.service';
import { createMockRedis } from '../../../test/helpers/mock-factories';

const FAKE_RAW = {} as EachMessagePayload;

function setup() {
  let registeredHandler: EnvelopeHandler | undefined;
  const consumer = {
    registerHandler: jest.fn((h: EnvelopeHandler) => {
      registeredHandler = h;
    }),
  } as unknown as KafkaConsumerService;
  const inventory = {
    commit: jest.fn().mockResolvedValue({ status: 'COMMITTED' }),
    release: jest.fn().mockResolvedValue({ status: 'RELEASED' }),
  } as unknown as jest.Mocked<InventoryService>;
  const redis = createMockRedis();
  // Eager construction registers the handler.
  new InventoryConsumer(consumer, inventory, redis.service);

  if (!registeredHandler) throw new Error('handler not registered');
  const handle = (env: EventEnvelope) => registeredHandler!(env, FAKE_RAW);
  return { handle, inventory, redis };
}

function envelope<T>(
  eventType: string,
  payload: T,
  eventId = 'ev-1',
): EventEnvelope<T> {
  return { eventId, eventType, occurredAt: '2026-01-01T00:00:00Z', payload };
}

describe('InventoryConsumer', () => {
  it('skips duplicate events (claimIdempotency=false)', async () => {
    const s = setup();
    s.redis.claimIdempotency.mockResolvedValueOnce(false);

    await s.handle(
      envelope<OrderConfirmedPayload>('OrderConfirmed', {
        orderId: 'o-1',
        reservationId: 'r-1',
        paymentId: 'p-1',
        customerId: 'c',
        email: 'e',
        items: [],
        total: 0,
      }),
    );

    expect(s.redis.claimIdempotency).toHaveBeenCalledWith(
      'inv:consumed:ev-1',
      7 * 24 * 60 * 60,
    );
    expect(s.inventory.commit).not.toHaveBeenCalled();
    expect(s.inventory.release).not.toHaveBeenCalled();
  });

  it('OrderConfirmed → calls inventory.commit with reservationId from payload', async () => {
    const s = setup();
    s.redis.claimIdempotency.mockResolvedValueOnce(true);

    await s.handle(
      envelope<OrderConfirmedPayload>('OrderConfirmed', {
        orderId: 'o-1',
        reservationId: 'r-42',
        paymentId: 'p-1',
        customerId: 'c',
        email: 'e',
        items: [],
        total: 0,
      }),
    );

    expect(s.inventory.commit).toHaveBeenCalledWith({ reservationId: 'r-42' });
    expect(s.inventory.release).not.toHaveBeenCalled();
  });

  it('OrderFailed with reservationId → calls inventory.release', async () => {
    const s = setup();
    s.redis.claimIdempotency.mockResolvedValueOnce(true);

    await s.handle(
      envelope<OrderFailedPayload>('OrderFailed', {
        orderId: 'o-1',
        reservationId: 'r-7',
        reason: 'card declined',
      }),
    );

    expect(s.inventory.release).toHaveBeenCalledWith({ reservationId: 'r-7' });
    expect(s.inventory.commit).not.toHaveBeenCalled();
  });

  it('OrderFailed without reservationId → no compensation', async () => {
    const s = setup();
    s.redis.claimIdempotency.mockResolvedValueOnce(true);

    await s.handle(
      envelope<OrderFailedPayload>('OrderFailed', {
        orderId: 'o-1',
        reason: 'inventory ran out',
      }),
    );

    expect(s.inventory.release).not.toHaveBeenCalled();
    expect(s.inventory.commit).not.toHaveBeenCalled();
  });
});
