import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { runner as pgMigrate } from 'node-pg-migrate';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';

declare global {

  var __PG_CONTAINER__: StartedPostgreSqlContainer | undefined;

  var __REDIS_CONTAINER__: StartedRedisContainer | undefined;
}

const REPO_ROOT = join(__dirname, '..', '..');

function extractOrdersSchema(): string {
  const sql = readFileSync(join(REPO_ROOT, 'scripts', 'init-db.sql'), 'utf8');
  // init-db.sql has `\c orders` then schema, then `-- ====` block separator.
  // Extract everything between `\c orders` and the next section header.
  const m = sql.match(/\\c\s+orders\s+([\s\S]*?)\n--\s*=/);
  if (!m) {
    throw new Error(
      'Could not extract orders schema from scripts/init-db.sql; ' +
        'expected `\\c orders` followed by `-- =` separator.',
    );
  }
  return m[1];
}

export default async function globalSetup(): Promise<void> {
  const pg = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orders')
    .withUsername('test')
    .withPassword('test')
    .start();

  const redis = await new RedisContainer('redis:7-alpine').start();

  const dsn = pg.getConnectionUri();

  const client = new Client({ connectionString: dsn });
  await client.connect();
  try {
    await client.query(extractOrdersSchema());
  } finally {
    await client.end();
  }

  await pgMigrate({
    databaseUrl: dsn,
    dir: join(REPO_ROOT, 'migrations', 'orders'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  });

  process.env.DATABASE_URL = dsn;
  process.env.REDIS_URL = redis.getConnectionUrl();

  globalThis.__PG_CONTAINER__ = pg;
  globalThis.__REDIS_CONTAINER__ = redis;
}
