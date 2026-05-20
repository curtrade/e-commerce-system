import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';

import type { PgConfig } from './pg.service';
import { PgService } from './pg.service';

export interface PgModuleAsyncOptions<
  TDeps extends readonly unknown[] = readonly unknown[],
> {
  inject: readonly unknown[];
  useFactory: (...args: TDeps) => PgConfig | Promise<PgConfig>;
}

@Module({})
export class PgModule {
  static forRootAsync<TDeps extends readonly unknown[]>(
    options: PgModuleAsyncOptions<TDeps>,
  ): DynamicModule {
    return {
      module: PgModule,
      global: true,
      providers: [
        {
          provide: PgService,
          inject: options.inject as never,
          useFactory: async (...args: unknown[]) => {
            const cfg = await options.useFactory(...(args as unknown as TDeps));
            return new PgService(cfg);
          },
        },
      ],
      exports: [PgService],
    };
  }
}
