import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';

import type { RedisConfig } from './redis.service';
import { RedisService } from './redis.service';

export interface RedisModuleAsyncOptions<
  TDeps extends readonly unknown[] = readonly unknown[],
> {
  inject: readonly unknown[];
  useFactory: (...args: TDeps) => RedisConfig | Promise<RedisConfig>;
}

@Module({})
export class RedisModule {
  static forRootAsync<TDeps extends readonly unknown[]>(
    options: RedisModuleAsyncOptions<TDeps>,
  ): DynamicModule {
    return {
      module: RedisModule,
      global: true,
      providers: [
        {
          provide: RedisService,
          inject: options.inject as never,
          useFactory: async (...args: unknown[]) => {
            const cfg = await options.useFactory(...(args as unknown as TDeps));
            return new RedisService(cfg);
          },
        },
      ],
      exports: [RedisService],
    };
  }
}
