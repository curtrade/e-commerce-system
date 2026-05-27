import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { PgService } from '../db/pg.service';

export const SERVICE_NAME = Symbol('SERVICE_NAME');

@SkipThrottle()
@Controller()
export class HealthController {
  constructor(
    @Inject(SERVICE_NAME) private readonly serviceName: string,
    private readonly pg: PgService,
  ) {}

  @Get('health')
  async health() {
    try {
      await this.pg.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException('Database unreachable');
    }
    return { status: 'ok', service: this.serviceName };
  }
}
