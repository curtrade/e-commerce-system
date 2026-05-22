import { Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { SagaRecoveryService } from './saga-recovery.service';
import { OrdersService } from './orders.service';

function setup() {
  const orders = {
    recoverStuckOrders: jest.fn().mockResolvedValue(0),
  } as unknown as jest.Mocked<OrdersService>;
  const scheduler = {
    addInterval: jest.fn(),
  } as unknown as jest.Mocked<SchedulerRegistry>;
  const service = new SagaRecoveryService(orders, scheduler);
  return { service, orders, scheduler };
}

describe('SagaRecoveryService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('registers a single recurring interval under the expected name', () => {
    const s = setup();
    s.service.onModuleInit();
    expect(s.scheduler.addInterval).toHaveBeenCalledTimes(1);
    expect(s.scheduler.addInterval.mock.calls[0][0]).toBe(
      'orders-saga-recovery',
    );
  });

  it('invokes recoverStuckOrders on each tick', async () => {
    const s = setup();
    s.service.onModuleInit();

    expect(s.orders.recoverStuckOrders).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(15_000);
    expect(s.orders.recoverStuckOrders).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(15_000);
    expect(s.orders.recoverStuckOrders).toHaveBeenCalledTimes(2);
  });

  it('swallows recovery errors and keeps the interval alive', async () => {
    const s = setup();
    const errSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    s.orders.recoverStuckOrders
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(7);

    s.service.onModuleInit();

    await jest.advanceTimersByTimeAsync(15_000);
    expect(s.orders.recoverStuckOrders).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('Saga recovery failed: db down'),
    );

    // Next tick still fires.
    await jest.advanceTimersByTimeAsync(15_000);
    expect(s.orders.recoverStuckOrders).toHaveBeenCalledTimes(2);
  });
});
