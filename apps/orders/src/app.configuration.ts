import { Configuration, Value } from '@itgorillaz/configify';
import { IsInt, IsNotEmpty } from 'class-validator';

@Configuration()
export class AppConfiguration {
  @IsInt()
  @Value('PORT', { parse: parseInt, default: 3000 })
  port!: number;

  @IsNotEmpty()
  @Value('DATABASE_URL')
  databaseUrl!: string;

  @IsNotEmpty()
  @Value('KAFKA_BROKERS', { default: 'kafka:9092' })
  kafkaBrokers!: string;

  @IsNotEmpty()
  @Value('REDIS_URL', { default: 'redis://redis:6379/0' })
  redisUrl!: string;

  @IsNotEmpty()
  @Value('INVENTORY_URL', { default: 'http://inventory:3000' })
  inventoryUrl!: string;

  @IsNotEmpty()
  @Value('PAYMENTS_URL', { default: 'http://payments:3000' })
  paymentsUrl!: string;

  @IsInt()
  @Value('RESERVATION_TTL_SEC', { parse: parseInt, default: 900 })
  reservationTtlSec!: number;

  @IsInt()
  @Value('SAGA_TIMEOUT_SEC', { parse: parseInt, default: 60 })
  sagaTimeoutSec!: number;
}
