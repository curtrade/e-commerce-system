-- Baseline migration for the `notifications` database.
-- Represents the cumulative state after scripts/init-db.sql.
--
-- On environments where the schema already exists, mark as applied:
--
--   DATABASE_URL="postgres://postgres:postgres@localhost:5432/notifications" \
--     npx prisma migrate resolve --applied 0_init \
--       --schema apps/notifications/prisma/schema.prisma

-- CreateTable
CREATE TABLE IF NOT EXISTS "notifications" (
    "id" BIGSERIAL NOT NULL,
    "order_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sent_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "notifications_order_idx" ON "notifications"("order_id");
