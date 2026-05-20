-- Bootstrap one Postgres instance with one database per microservice.
-- Runs only on first volume init (docker-entrypoint-initdb.d).

CREATE DATABASE orders;
CREATE DATABASE payments;
CREATE DATABASE inventory;
CREATE DATABASE notifications;

-- ============================================================
-- orders
-- ============================================================
\c orders

CREATE TABLE orders (
    id              uuid PRIMARY KEY,
    customer_id     text        NOT NULL,
    email           text        NOT NULL,
    items           jsonb       NOT NULL,
    total           numeric(12, 2) NOT NULL,
    status          text        NOT NULL,
    reservation_id  uuid,
    payment_id      uuid,
    attempt_id      uuid        NOT NULL,
    error           text,
    created_at      timestamptz NOT NULL DEFAULT NOW(),
    updated_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX orders_status_created_idx ON orders (status, created_at);

CREATE TABLE orders_outbox (
    id              uuid PRIMARY KEY,
    aggregate_id    uuid        NOT NULL,
    topic           text        NOT NULL,
    event_type      text        NOT NULL,
    payload         jsonb       NOT NULL,
    trace_id        text,
    attempts        int         NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT NOW(),
    published_at    timestamptz
);

CREATE INDEX orders_outbox_unpublished_idx
    ON orders_outbox (created_at)
    WHERE published_at IS NULL;

-- ============================================================
-- payments
-- ============================================================
\c payments

CREATE TABLE payments (
    id              uuid PRIMARY KEY,
    order_id        text        NOT NULL,
    amount          numeric(12, 2) NOT NULL,
    status          text        NOT NULL,
    idempotency_key text        NOT NULL UNIQUE,
    created_at      timestamptz NOT NULL DEFAULT NOW(),
    updated_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX payments_order_idx ON payments (order_id);

-- ============================================================
-- inventory
-- ============================================================
\c inventory

CREATE TABLE inventory_items (
    sku             text PRIMARY KEY,
    available       int         NOT NULL CHECK (available >= 0),
    reserved        int         NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    sold            int         NOT NULL DEFAULT 0 CHECK (sold >= 0),
    updated_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE reservations (
    id              uuid PRIMARY KEY,
    order_id        text        NOT NULL,
    items           jsonb       NOT NULL,
    status          text        NOT NULL,
    expires_at      timestamptz NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT NOW(),
    updated_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX reservations_status_expiry_idx
    ON reservations (status, expires_at);

-- Seed a tiny catalog for happy-path smoke testing.
INSERT INTO inventory_items (sku, available) VALUES
    ('SKU-RED-SHIRT-M', 100),
    ('SKU-BLUE-MUG',    250),
    ('SKU-NOTEBOOK-A5', 500);

-- ============================================================
-- notifications
-- ============================================================
\c notifications

CREATE TABLE notifications (
    id              bigserial PRIMARY KEY,
    order_id        text        NOT NULL,
    channel         text        NOT NULL,
    recipient       text        NOT NULL,
    subject         text        NOT NULL,
    body            text        NOT NULL,
    sent_at         timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX notifications_order_idx ON notifications (order_id);
