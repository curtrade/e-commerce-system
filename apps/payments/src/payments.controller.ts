import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ChargeDto, RefundDto } from './dto/charge.dto';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('charge')
  @HttpCode(201)
  charge(
    @Body() dto: ChargeDto,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    if (!idemKey) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    return this.payments.charge(dto, idemKey);
  }

  @Post('refund')
  @HttpCode(200)
  refund(@Body() dto: RefundDto) {
    return this.payments.refund(dto);
  }

  @Get('by-order/:orderId')
  async byOrder(@Param('orderId') orderId: string) {
    const row = await this.payments.getByOrder(orderId);
    if (!row) throw new NotFoundException('No payment for this order');
    return row;
  }
}
