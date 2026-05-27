-- Baseline migration for the `inventory` database.
-- Represents the cumulative state after scripts/init-db.sql.
--
-- On environments where the schema already exists, mark as applied:
--
--   DATABASE_URL="postgres://postgres:postgres@localhost:5432/inventory" \
--     npx prisma migrate resolve --applied 0_init \
--       --schema apps/inventory/prisma/schema.prisma

-- CreateTable
CREATE TABLE IF NOT EXISTS "inventory_items" (
    "sku" TEXT NOT NULL,
    "available" INTEGER NOT NULL CHECK ("available" >= 0),
    "reserved" INTEGER NOT NULL DEFAULT 0 CHECK ("reserved" >= 0),
    "sold" INTEGER NOT NULL DEFAULT 0 CHECK ("sold" >= 0),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("sku")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "reservations" (
    "id" UUID NOT NULL,
    "order_id" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "reservations_status_expiry_idx" ON "reservations"("status", "expires_at");

-- Seed a tiny catalog for happy-path smoke testing.
INSERT INTO "inventory_items" ("sku", "available") VALUES
    ('SKU-RED-SHIRT-M', 100),
    ('SKU-BLUE-MUG',    250),
    ('SKU-NOTEBOOK-A5', 500)
ON CONFLICT ("sku") DO NOTHING;
