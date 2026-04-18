-- Multi-webhooks refactor: 1-per-user → N-per-user (up to 10 enforced in app layer)
-- Preserves existing WebhookConfig rows by copying them into the new Webhook table
-- with name = "Default" and enabled = true before dropping the old table.

-- 1) CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "url" TEXT,
    "botToken" TEXT,
    "chatId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- 2) CreateIndex
CREATE INDEX "Webhook_userId_enabled_idx" ON "Webhook"("userId", "enabled");

-- 3) AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4) Backfill: copy every existing WebhookConfig row into Webhook
--    (guarded by to_regclass so the migration works on fresh DBs where
--    WebhookConfig was never created.)
DO $$
BEGIN
  IF to_regclass('public."WebhookConfig"') IS NOT NULL THEN
    INSERT INTO "Webhook" ("id", "userId", "name", "type", "url", "botToken", "chatId", "enabled", "createdAt", "updatedAt")
    SELECT
      gen_random_uuid()::text,
      "userId",
      'Default',
      "type",
      "url",
      "botToken",
      "chatId",
      true,
      COALESCE("updatedAt", CURRENT_TIMESTAMP),
      COALESCE("updatedAt", CURRENT_TIMESTAMP)
    FROM "WebhookConfig";
  END IF;
END $$;

-- 5) DropTable (guarded for fresh DBs)
DROP TABLE IF EXISTS "WebhookConfig";
