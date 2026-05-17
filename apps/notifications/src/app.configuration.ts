import { Configuration, Value } from '@itgorillaz/configify';
import { IsEmail, IsInt, IsNotEmpty } from 'class-validator';

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
  @Value('REDIS_URL', { default: 'redis://redis:6379/3' })
  redisUrl!: string;

  @IsEmail()
  @Value('SENDER_EMAIL', { default: 'ops@example.com' })
  senderEmail!: string;
}
