-- Add user-owned ticker groups/tabs while preserving the existing flat
-- UserTicker table as the quote-tracking source of truth.

-- CreateTable
CREATE TABLE "UserTickerGroup" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserTickerGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserTickerGroupItem" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserTickerGroupItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserTickerGroup_userId_position_idx" ON "UserTickerGroup"("userId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "UserTickerGroup_userId_name_key" ON "UserTickerGroup"("userId", "name");

-- CreateIndex
CREATE INDEX "UserTickerGroupItem_userId_idx" ON "UserTickerGroupItem"("userId");

-- CreateIndex
CREATE INDEX "UserTickerGroupItem_groupId_position_idx" ON "UserTickerGroupItem"("groupId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "UserTickerGroupItem_groupId_symbol_key" ON "UserTickerGroupItem"("groupId", "symbol");

-- AddForeignKey
ALTER TABLE "UserTickerGroup" ADD CONSTRAINT "UserTickerGroup_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserTickerGroupItem" ADD CONSTRAINT "UserTickerGroupItem_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "UserTickerGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill every existing user with a locked Default group.
INSERT INTO "UserTickerGroup" ("id", "userId", "name", "position", "isDefault", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    "id",
    'Default',
    0,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "User"
ON CONFLICT ("userId", "name") DO NOTHING;

-- Copy existing UserTicker rows into each user's Default group, preserving order.
INSERT INTO "UserTickerGroupItem" ("id", "groupId", "userId", "symbol", "position", "createdAt")
SELECT
    gen_random_uuid()::text,
    g."id",
    t."userId",
    t."symbol",
    t."position",
    t."createdAt"
FROM "UserTicker" t
JOIN "UserTickerGroup" g
  ON g."userId" = t."userId"
 AND g."name" = 'Default'
ON CONFLICT ("groupId", "symbol") DO NOTHING;
