import { Configuration, Value } from '@itgorillaz/configify';
import { IsInt, IsNotEmpty, IsNumber, Min, Max } from 'class-validator';

@Configuration()
export class AppConfiguration {
  @IsInt()
  @Value('PORT', { parse: parseInt, default: 3000 })
  port!: number;

  @IsNotEmpty()
  @Value('DATABASE_URL')
  databaseUrl!: string;

  @IsNotEmpty()
  @Value('REDIS_URL', { default: 'redis://redis:6379/2' })
  redisUrl!: string;

  /** Probability of a fake provider failure (0–1). For chaos testing the saga. */
  @IsNumber()
  @Min(0)
  @Max(1)
  @Value('FAILURE_RATE', { parse: parseFloat, default: 0 })
  failureRate!: number;
}
