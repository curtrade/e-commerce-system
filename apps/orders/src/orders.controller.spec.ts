import { NotFoundException } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';

function setup() {
  const service = {
    createOrder: jest.fn(),
    getOrder: jest.fn(),
  } as unknown as jest.Mocked<OrdersService>;
  const controller = new OrdersController(service);
  return { controller, service };
}

describe('OrdersController', () => {
  it('POST / forwards DTO to service.createOrder and returns its result', async () => {
    const { controller, service } = setup();
    const dto: CreateOrderDto = {
      customerId: 'c-1',
      email: 'a@b.c',
      items: [{ sku: 'SKU-A', qty: 1, unitPrice: 10 }],
    };
    const expected = { orderId: 'o-1', status: 'CONFIRMED' };
    (service.createOrder as jest.Mock).mockResolvedValue(expected);

    const res = await controller.create(dto);

    expect(service.createOrder).toHaveBeenCalledWith(dto);
    expect(res).toBe(expected);
  });

  it('GET /:id returns the row when found', async () => {
    const { controller, service } = setup();
    const row = { id: 'o-1', status: 'CONFIRMED' };
    (service.getOrder as jest.Mock).mockResolvedValue(row);

    const res = await controller.get('o-1');

    expect(service.getOrder).toHaveBeenCalledWith('o-1');
    expect(res).toBe(row);
  });

  it('GET /:id throws NotFoundException with the order id when not found', async () => {
    const { controller, service } = setup();
    (service.getOrder as jest.Mock).mockResolvedValue(null);

    const err = await controller.get('missing').catch((e) => e as Error);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toBe('Order missing not found');
  });
});
