-- Baseline migration for the `payments` database.
-- Represents the cumulative state after scripts/init-db.sql.
--
-- On environments where the schema already exists, mark as applied:
--
--   DATABASE_URL="postgres://postgres:postgres@localhost:5432/payments" \
--     npx prisma migrate resolve --applied 0_init \
--       --schema apps/payments/prisma/schema.prisma

-- CreateTable
CREATE TABLE IF NOT EXISTS "payments" (
    "id" UUID NOT NULL,
    "order_id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "payments_idempotency_key_key" ON "payments"("idempotency_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "payments_order_idx" ON "payments"("order_id");
