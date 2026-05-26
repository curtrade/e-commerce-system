import { Client } from 'pg';

export const ORDERS_URL = 'http://localhost:3001';

export async function pgQuery<T extends Record<string, unknown>>(
  db: string,
  sql: string,
  params: unknown[] = [],
) {
  const client = new Client({
    connectionString: `postgres://postgres:postgres@localhost:5432/${db}`,
  });
  await client.connect();
  try {
    return await client.query<T>(sql, params);
  } finally {
    await client.end();
  }
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
