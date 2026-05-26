import { ORDERS_URL, createOrder, pgQuery, waitFor } from './helpers';

const ORDER_BODY = {
  customerId: 'c-e2e',
  email: 'e2e@test.com',
  items: [{ sku: 'SKU-BLUE-MUG', qty: 1, unitPrice: 7.5 }],
};

describe('Order Saga (E2E)', () => {
  describe('happy path', () => {
    let orderId: string;
    let reservationId: string;

    it('POST /orders → 201 CONFIRMED', async () => {
      const { status, body } = await createOrder(ORDER_BODY);

      expect(status).toBe(201);
      expect(body.status).toBe('CONFIRMED');
      expect(body.orderId).toBeDefined();
      expect(body.reservationId).toBeDefined();
      expect(body.paymentId).toBeDefined();
      expect(body.total).toBe(7.5);

      orderId = body.orderId as string;
      reservationId = body.reservationId as string;
    });

    it('GET /orders/:id → order row with CONFIRMED', async () => {
      const res = await fetch(`${ORDERS_URL}/orders/${orderId}`);
      expect(res.status).toBe(200);

      const row = (await res.json()) as Record<string, unknown>;
      expect(row.status).toBe('CONFIRMED');
    });

    it('outbox publishes OrderConfirmed → inventory commits reservation', async () => {
      await waitFor(async () => {
        const { rows } = await pgQuery<{ status: string }>(
          'inventory',
          'SELECT status FROM reservations WHERE id = $1',
          [reservationId],
        );
        return rows.length > 0 && rows[0].status === 'COMMITTED';
      });
    });

    it('notifications consumer creates email record', async () => {
      await waitFor(async () => {
        const { rows } = await pgQuery<{ subject: string }>(
          'notifications',
          "SELECT subject FROM notifications WHERE order_id = $1 AND channel = 'email'",
          [orderId],
        );
        return rows.length > 0;
      });

      const { rows } = await pgQuery<{ subject: string; recipient: string }>(
        'notifications',
        'SELECT subject, recipient FROM notifications WHERE order_id = $1',
        [orderId],
      );
      expect(rows[0].subject).toBe('Order confirmed');
      expect(rows[0].recipient).toBe('e2e@test.com');
    });
  });

  describe('insufficient stock → FAILED_INVENTORY', () => {
    it('qty=999999 → FAILED_INVENTORY, no payment charged', async () => {
      const { status, body } = await createOrder({
        ...ORDER_BODY,
        items: [{ sku: 'SKU-BLUE-MUG', qty: 999_999, unitPrice: 7.5 }],
      });

      expect(status).toBe(201);
      expect(body.status).toBe('FAILED_INVENTORY');
      expect(body.reason).toBeDefined();
      expect(body.paymentId).toBeUndefined();

      const orderId = body.orderId as string;
      const { rows } = await pgQuery<{ status: string }>(
        'orders',
        'SELECT status FROM orders WHERE id = $1',
        [orderId],
      );
      expect(rows[0].status).toBe('FAILED_INVENTORY');
    });
  });

  describe('GET nonexistent order → 404', () => {
    it('returns NotFoundException', async () => {
      const res = await fetch(
        `${ORDERS_URL}/orders/00000000-0000-0000-0000-000000000000`,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('validation', () => {
    it('empty body → 400', async () => {
      const res = await fetch(`${ORDERS_URL}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(400);
    });

    it('items=[] → 400', async () => {
      const { status } = await createOrder({
        customerId: 'c',
        email: 'a@b.c',
        items: [],
      });
      expect(status).toBe(400);
    });

    it('invalid email → 400', async () => {
      const { status } = await createOrder({
        customerId: 'c',
        email: 'not-an-email',
        items: [{ sku: 'X', qty: 1, unitPrice: 1 }],
      });
      expect(status).toBe(400);
    });
  });
});
