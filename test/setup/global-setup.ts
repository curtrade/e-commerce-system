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
const SERVICES = ['orders', 'payments', 'inventory', 'notifications'] as const;
type Service = (typeof SERVICES)[number];

function extractSchema(service: Service): string {
  const sql = readFileSync(join(REPO_ROOT, 'scripts', 'init-db.sql'), 'utf8');
  // Sections in init-db.sql start with `\c <service>` and end either at the
  // next `-- =` separator or at end of file (notifications is last).
  const re = new RegExp(
    String.raw`\\c\s+${service}\s+([\s\S]*?)(?=\n--\s*=|$)`,
  );
  const m = sql.match(re);
  if (!m) throw new Error(`No schema for ${service} in scripts/init-db.sql`);
  return m[1];
}

function dsnFor(baseUri: string, db: string): string {
  // PostgreSqlContainer.getConnectionUri() returns .../test by default.
  return baseUri.replace(/\/[^/]+$/, '/' + db);
}

export default async function globalSetup(): Promise<void> {
  const pg = await new PostgreSqlContainer('postgres:16-alpine')
    .withUsername('test')
    .withPassword('test')
    .start();

  const redis = await new RedisContainer('redis:7-alpine').start();

  const bootstrapUri = pg.getConnectionUri();

  // Create per-service databases from the bootstrap connection.
  const root = new Client({ connectionString: bootstrapUri });
  await root.connect();
  try {
    for (const db of SERVICES) {
      await root.query(`CREATE DATABASE ${db}`);
    }
  } finally {
    await root.end();
  }

  // Apply each schema fragment to its own DB.
  for (const db of SERVICES) {
    const client = new Client({ connectionString: dsnFor(bootstrapUri, db) });
    await client.connect();
    try {
      await client.query(extractSchema(db));
    } finally {
      await client.end();
    }
  }

  // Run orders migrations on top of the seeded schema.
  await pgMigrate({
    databaseUrl: dsnFor(bootstrapUri, 'orders'),
    dir: join(REPO_ROOT, 'migrations', 'orders'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  });

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
