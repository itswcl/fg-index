-- CreateTable
CREATE TABLE "UserTicker" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserTicker_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserTicker_userId_idx" ON "UserTicker"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserTicker_userId_symbol_key" ON "UserTicker"("userId", "symbol");

-- AddForeignKey
ALTER TABLE "UserTicker" ADD CONSTRAINT "UserTicker_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
