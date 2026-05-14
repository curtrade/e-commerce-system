export const ORDERS_TOPIC = 'orders.events';

export type OrderEventType =
  | 'OrderConfirmed'
  | 'OrderFailed'
  | 'OrderRefunded'
  | 'OrderFulfilled';

export interface OrderItem {
  sku: string;
  qty: number;
  unitPrice: number;
}

export interface OrderConfirmedPayload {
  orderId: string;
  reservationId: string;
  paymentId: string;
  customerId: string;
  email: string;
  items: OrderItem[];
  total: number;
}

export interface OrderFailedPayload {
  orderId: string;
  reservationId?: string;
  reason: string;
}

export interface OrderFulfilledPayload {
  orderId: string;
  reservationId: string;
}

export interface OrderRefundedPayload {
  orderId: string;
  paymentId: string;
  reason: string;
}

export type OrderEventPayload =
  | OrderConfirmedPayload
  | OrderFailedPayload
  | OrderFulfilledPayload
  | OrderRefundedPayload;
