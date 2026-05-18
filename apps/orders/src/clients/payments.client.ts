import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { AppConfiguration } from '../app.configuration';

export interface ChargeResponse {
  paymentId: string;
  status: 'CHARGED';
}

@Injectable()
export class PaymentsClient {
  constructor(
    private readonly http: HttpService,
    private readonly cfg: AppConfiguration,
  ) {}

  async charge(args: {
    orderId: string;
    amount: number;
    idempotencyKey: string;
  }): Promise<ChargeResponse> {
    const url = `${this.cfg.paymentsUrl}/payments/charge`;
    const { data } = await firstValueFrom(
      this.http.post<ChargeResponse>(
        url,
        { orderId: args.orderId, amount: args.amount },
        {
          headers: { 'Idempotency-Key': args.idempotencyKey },
          timeout: 5000,
        },
      ),
    );
    return data;
  }
}
