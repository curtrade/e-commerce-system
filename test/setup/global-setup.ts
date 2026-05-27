import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
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
const SERVICES = ['orders', 'payments', 'inventory', 'notifications'] as const;
type Service = (typeof SERVICES)[number];

function loadMigrations(service: Service): string {
  const migrationsDir = join(REPO_ROOT, 'apps', service, 'prisma', 'migrations');
  const dirs = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  return dirs
    .map((dir) => {
      const sqlPath = join(migrationsDir, dir, 'migration.sql');
      return readFileSync(sqlPath, 'utf8');
    })
    .join('\n');
}

function dsnFor(baseUri: string, db: string): string {
  return baseUri.replace(/\/[^/]+$/, '/' + db);
}

export default async function globalSetup(): Promise<void> {
  const pg = await new PostgreSqlContainer('postgres:16-alpine')
    .withUsername('test')
    .withPassword('test')
    .start();

  const redis = await new RedisContainer('redis:7-alpine').start();

  const bootstrapUri = pg.getConnectionUri();

  const root = new Client({ connectionString: bootstrapUri });
  await root.connect();
  try {
    for (const db of SERVICES) {
      await root.query(`CREATE DATABASE ${db}`);
    }
  } finally {
    await root.end();
  }

  for (const db of SERVICES) {
    const client = new Client({ connectionString: dsnFor(bootstrapUri, db) });
    await client.connect();
    try {
      await client.query(loadMigrations(db));
    } finally {
      await client.end();
    }
  }

  process.env.DATABASE_URL_ORDERS = dsnFor(bootstrapUri, 'orders');
  process.env.DATABASE_URL_PAYMENTS = dsnFor(bootstrapUri, 'payments');
  process.env.DATABASE_URL_INVENTORY = dsnFor(bootstrapUri, 'inventory');
  process.env.DATABASE_URL_NOTIFICATIONS = dsnFor(
    bootstrapUri,
    'notifications',
  );
  // Backwards-compat for older orders tests that read DATABASE_URL.
  process.env.DATABASE_URL = process.env.DATABASE_URL_ORDERS;
  process.env.REDIS_URL = redis.getConnectionUrl();

  globalThis.__PG_CONTAINER__ = pg;
  globalThis.__REDIS_CONTAINER__ = redis;
}
