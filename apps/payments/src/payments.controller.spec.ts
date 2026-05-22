import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { ChargeDto, RefundDto } from './dto/charge.dto';

function setup() {
  const service = {
    charge: jest.fn(),
    refund: jest.fn(),
    getByOrder: jest.fn(),
  } as unknown as jest.Mocked<PaymentsService>;
  const controller = new PaymentsController(service);
  return { controller, service };
}

describe('PaymentsController', () => {
  it('POST /charge without Idempotency-Key header → 400', () => {
    const { controller, service } = setup();
    const dto: ChargeDto = { orderId: 'o-1', amount: 10 };

    expect(() => controller.charge(dto, undefined)).toThrow(
      BadRequestException,
    );
    expect(() => controller.charge(dto, undefined)).toThrow(
      'Idempotency-Key header is required',
    );
    expect(service.charge).not.toHaveBeenCalled();
  });

  it('POST /charge forwards DTO and idempotency key to service', () => {
    const { controller, service } = setup();
    const dto: ChargeDto = { orderId: 'o-1', amount: 10 };
    const result = { paymentId: 'p-1', status: 'CHARGED' as const };
    (service.charge as jest.Mock).mockResolvedValue(result);

    const res = controller.charge(dto, 'idem-x');

    expect(service.charge).toHaveBeenCalledWith(dto, 'idem-x');
    expect(res).resolves.toBe(result);
  });

  it('POST /refund forwards DTO', () => {
    const { controller, service } = setup();
    const dto: RefundDto = { paymentId: 'p-1', reason: 'asked' };
    (service.refund as jest.Mock).mockResolvedValue({ status: 'REFUNDED' });

    const res = controller.refund(dto);

    expect(service.refund).toHaveBeenCalledWith(dto);
    expect(res).resolves.toEqual({ status: 'REFUNDED' });
  });

  it('GET /by-order/:orderId returns row when found', async () => {
    const { controller, service } = setup();
    const row = { id: 'p-1', order_id: 'o-1', status: 'CHARGED' };
    (service.getByOrder as jest.Mock).mockResolvedValue(row);

    const res = await controller.byOrder('o-1');
    expect(service.getByOrder).toHaveBeenCalledWith('o-1');
    expect(res).toBe(row);
  });

  it('GET /by-order/:orderId throws NotFoundException when missing', async () => {
    const { controller, service } = setup();
    (service.getByOrder as jest.Mock).mockResolvedValue(null);

    await expect(controller.byOrder('missing')).rejects.toThrow(
      NotFoundException,
    );
    await expect(controller.byOrder('missing')).rejects.toThrow(
      'No payment for this order',
    );
  });
});
