import { DynamicModule, Module } from '@nestjs/common';
import { RedisConfig, RedisService } from './redis.service';

export interface RedisModuleAsyncOptions {
  inject: unknown[];
  useFactory: (...args: unknown[]) => RedisConfig | Promise<RedisConfig>;
}

@Module({})
export class RedisModule {
  static forRootAsync(options: RedisModuleAsyncOptions): DynamicModule {
    return {
      module: RedisModule,
      global: true,
      providers: [
        {
          provide: RedisService,
          inject: options.inject as never,
          useFactory: async (...args: unknown[]) => {
            const cfg = await options.useFactory(...args);
            return new RedisService(cfg);
          },
        },
      ],
      exports: [RedisService],
    };
  }
}
