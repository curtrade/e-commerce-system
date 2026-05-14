import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

export interface PgConfig {
  connectionString: string;
  max?: number;
}

export const PG_CONFIG = Symbol('PG_CONFIG');

@Injectable()
export class PgService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PgService.name);
  private pool!: Pool;

  constructor(private readonly config: PgConfig) {}

  onModuleInit(): void {
    this.pool = new Pool({
      connectionString: this.config.connectionString,
      max: this.config.max ?? 10,
    });
    this.pool.on('error', (err) =>
      this.logger.error('Unexpected pg pool error', err),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool?.end();
  }

  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params as never);
  }

  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
