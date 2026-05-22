import { PgService, RedisService } from '@app/common';

export function createTestPg(): PgService {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set — globalSetup did not run?');
  }
  const svc = new PgService({ connectionString: process.env.DATABASE_URL });
  svc.onModuleInit();
  return svc;
}

export function createTestRedis(): RedisService {
  if (!process.env.REDIS_URL) {
    throw new Error('REDIS_URL not set — globalSetup did not run?');
  }
  const svc = new RedisService({ url: process.env.REDIS_URL });
  svc.onModuleInit();
  return svc;
}
