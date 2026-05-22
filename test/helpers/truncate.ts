import type { PgService } from '@app/common';

export async function truncateOrders(pg: PgService): Promise<void> {
  await pg.query(
    'TRUNCATE TABLE orders, orders_outbox RESTART IDENTITY CASCADE',
  );
}
