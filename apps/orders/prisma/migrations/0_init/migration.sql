-- Baseline migration for the `orders` database.
-- Represents the cumulative state after:
--   * scripts/init-db.sql (initial orders + orders_outbox)
--   * migrations/orders/1779353887699_orders-outbox-trace-id.js (added trace_id)
--   * migrations/orders/1779373518241_orders-outbox-trace-context.js (dropped trace_id, added trace_context)
--
-- On environments where the schema already exists (created by node-pg-migrate
-- before the Prisma cutover), mark this migration as applied WITHOUT running it:
--
--   npx prisma migrate resolve --applied 0_init \
--     --schema apps/orders/prisma/schema.prisma
--
-- On fresh databases, `prisma migrate deploy` will execute it normally.

-- CreateTable
CREATE TABLE IF NOT EXISTS "orders" (
    "id" UUID NOT NULL,
    "customer_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL,
    "reservation_id" UUID,
    "payment_id" UUID,
    "attempt_id" UUID NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "orders_status_created_idx" ON "orders"("status", "created_at");

-- CreateTable
CREATE TABLE IF NOT EXISTS "orders_outbox" (
    "id" UUID NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,
    "trace_context" TEXT,

    CONSTRAINT "orders_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Partial index, not expressible in Prisma schema syntax — declared here only.
CREATE INDEX IF NOT EXISTS "orders_outbox_unpublished_idx"
    ON "orders_outbox" ("created_at")
    WHERE "published_at" IS NULL;
