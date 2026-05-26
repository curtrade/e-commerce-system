import { PgService, RedisService } from '@app/common';

export type Service = 'orders' | 'payments' | 'inventory' | 'notifications';

const ENV_VAR: Record<Service, string> = {
  orders: 'DATABASE_URL_ORDERS',
  payments: 'DATABASE_URL_PAYMENTS',
  inventory: 'DATABASE_URL_INVENTORY',
  notifications: 'DATABASE_URL_NOTIFICATIONS',
};

export function createTestPg(service: Service = 'orders'): PgService {
  const dsn = process.env[ENV_VAR[service]];
  if (!dsn) {
    throw new Error(`${ENV_VAR[service]} not set — globalSetup did not run?`);
  }
  const svc = new PgService({ connectionString: dsn });
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
