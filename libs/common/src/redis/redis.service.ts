import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';

export interface RedisConfig {
  url: string;
}

@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;

  constructor(private readonly config: RedisConfig) {}

  onModuleInit(): void {
    this.client = new Redis(this.config.url, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
    this.client.on('error', (err) => this.logger.error('Redis error', err));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client?.quit();
  }

  raw(): Redis {
    return this.client;
  }

  /** Atomic decrement that refuses to go negative. Returns remaining stock or -1 if rejected. */
  async tryReserve(key: string, qty: number): Promise<number> {
    const lua = `
      local cur = tonumber(redis.call('GET', KEYS[1]) or '-1')
      if cur < 0 then return -1 end
      local need = tonumber(ARGV[1])
      if cur < need then return -1 end
      return redis.call('DECRBY', KEYS[1], need)
    `;
    const res = await this.client.eval(lua, 1, key, qty);
    return Number(res);
  }

  async release(key: string, qty: number): Promise<number> {
    const res = await this.client.incrby(key, qty);
    return res;
  }

  /** SETNX with TTL — returns true if the idempotency key was acquired (new). */
  async claimIdempotency(key: string, ttlSeconds: number): Promise<boolean> {
    const res = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX');
    return res === 'OK';
  }
}
