import { DynamicModule, Module } from '@nestjs/common';
import { PgService } from './pg.service';

export interface PgModuleAsyncOptions {
  inject: unknown[];
  useFactory: (
    ...args: unknown[]
  ) =>
    | { connectionString: string; max?: number }
    | Promise<{ connectionString: string; max?: number }>;
}

@Module({})
export class PgModule {
  static forRootAsync(options: PgModuleAsyncOptions): DynamicModule {
    return {
      module: PgModule,
      global: true,
      providers: [
        {
          provide: PgService,
          inject: options.inject as never,
          useFactory: async (...args: unknown[]) => {
            const cfg = await options.useFactory(...args);
            return new PgService(cfg);
          },
        },
      ],
      exports: [PgService],
    };
  }
}
