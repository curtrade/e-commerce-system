import { Pool } from 'pg';

export const ORDERS_URL = 'http://localhost:3001';

const pools = new Map<string, Pool>();

function getPool(db: string): Pool {
  let pool = pools.get(db);
  if (!pool) {
    pool = new Pool({
      connectionString: `postgres://postgres:postgres@localhost:5432/${db}`,
      max: 3,
    });
    pools.set(db, pool);
  }
  return pool;
}

export async function pgQuery<T extends Record<string, unknown>>(
  db: string,
  sql: string,
  params: unknown[] = [],
) {
  return getPool(db).query<T>(sql, params);
}

export async function closePools() {
  for (const pool of pools.values()) {
    await pool.end();
  }
  pools.clear();
}

export async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('waitFor timed out');
}

export async function createOrder(body: Record<string, unknown>) {
  const res = await fetch(`${ORDERS_URL}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}
