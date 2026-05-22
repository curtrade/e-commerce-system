import type { PgService } from '@app/common';

export async function truncate(
  pg: PgService,
  ...tables: string[]
): Promise<void> {
  if (tables.length === 0) return;
  await pg.query(
    `TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`,
  );
}

export const truncateOrders = (pg: PgService) =>
  truncate(pg, 'orders', 'orders_outbox');

export const truncatePayments = (pg: PgService) => truncate(pg, 'payments');

export const truncateReservations = (pg: PgService) =>
  truncate(pg, 'reservations');

export const truncateNotifications = (pg: PgService) =>
  truncate(pg, 'notifications');
