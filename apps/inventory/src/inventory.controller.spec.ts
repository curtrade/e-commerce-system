import { BadRequestException } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { CommitDto, ReleaseDto, ReserveDto } from './dto/reserve.dto';

function setup() {
  const service = {
    reserve: jest.fn(),
    release: jest.fn(),
    commit: jest.fn(),
  } as unknown as jest.Mocked<InventoryService>;
  const controller = new InventoryController(service);
  return { controller, service };
}

const RESERVE: ReserveDto = {
  orderId: 'o-1',
  ttlSec: 900,
  items: [{ sku: 'SKU-A', qty: 1 }],
};

describe('InventoryController', () => {
  it('POST /reserve without Idempotency-Key header → 400', () => {
    const { controller, service } = setup();

    const err = (() => {
      try {
        void controller.reserve(RESERVE, undefined);
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err?.message).toBe('Idempotency-Key header is required');
    expect(service.reserve).not.toHaveBeenCalled();
  });

  it('POST /reserve forwards DTO and idempotency key', async () => {
    const { controller, service } = setup();
    (service.reserve as jest.Mock).mockResolvedValue({
      reservationId: 'r-1',
      expiresAt: 't',
    });

    await controller.reserve(RESERVE, 'idem-x');

    expect(service.reserve).toHaveBeenCalledWith(RESERVE, 'idem-x');
  });

  it('POST /release forwards DTO', async () => {
    const { controller, service } = setup();
    const dto: ReleaseDto = { reservationId: 'r-1' };
    (service.release as jest.Mock).mockResolvedValue({ status: 'RELEASED' });

    await controller.release(dto);

    expect(service.release).toHaveBeenCalledWith(dto);
  });

  it('POST /commit forwards DTO', async () => {
    const { controller, service } = setup();
    const dto: CommitDto = { reservationId: 'r-1' };
    (service.commit as jest.Mock).mockResolvedValue({ status: 'COMMITTED' });

    await controller.commit(dto);

    expect(service.commit).toHaveBeenCalledWith(dto);
  });
});
