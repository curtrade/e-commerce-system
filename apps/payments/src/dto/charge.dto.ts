import { IsNotEmpty, IsNumber, Min } from 'class-validator';

export class ChargeDto {
  @IsNotEmpty()
  orderId!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;
}

export class RefundDto {
  @IsNotEmpty()
  paymentId!: string;

  @IsNotEmpty()
  reason!: string;
}
