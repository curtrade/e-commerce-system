import { Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InventoryReaper } from './inventory.reaper';
import { InventoryService } from './inventory.service';

function setup() {
  const inventory = {
    expirePending: jest.fn().mockResolvedValue(0),
  } as unknown as jest.Mocked<InventoryService>;
  const scheduler = {
    addInterval: jest.fn(),
  } as unknown as jest.Mocked<SchedulerRegistry>;
  const reaper = new InventoryReaper(inventory, scheduler);
  return { reaper, inventory, scheduler };
}

describe('InventoryReaper', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('registers a single interval under the expected name', () => {
    const s = setup();
    s.reaper.onModuleInit();
    expect(s.scheduler.addInterval).toHaveBeenCalledTimes(1);
    expect(s.scheduler.addInterval.mock.calls[0][0]).toBe(
      'inventory-ttl-reaper',
    );
  });

  it('calls expirePending on each 30s tick', async () => {
    const s = setup();
    s.reaper.onModuleInit();

    await jest.advanceTimersByTimeAsync(30_000);
    expect(s.inventory.expirePending).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(s.inventory.expirePending).toHaveBeenCalledTimes(2);
  });

  it('swallows expirePending errors and keeps the interval alive', async () => {
    const s = setup();
    const errSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    s.inventory.expirePending
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(5);

    s.reaper.onModuleInit();

    await jest.advanceTimersByTimeAsync(30_000);
    expect(s.inventory.expirePending).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('Reaper failed: db down'),
    );

    await jest.advanceTimersByTimeAsync(30_000);
    expect(s.inventory.expirePending).toHaveBeenCalledTimes(2);
  });
});
