-- CreateTable
CREATE TABLE "TickerQuoteCache" (
    "symbol" TEXT NOT NULL,
    "name" TEXT,
    "price" DOUBLE PRECISION NOT NULL,
    "previousClose" DOUBLE PRECISION NOT NULL,
    "change" DOUBLE PRECISION NOT NULL,
    "changePercent" DOUBLE PRECISION NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "sourceUrl" TEXT,
    "marketSession" TEXT,
    "postMarketPrice" DOUBLE PRECISION,
    "postMarketChange" DOUBLE PRECISION,
    "postMarketChangePercent" DOUBLE PRECISION,
    "preMarketPrice" DOUBLE PRECISION,
    "preMarketChange" DOUBLE PRECISION,
    "preMarketChangePercent" DOUBLE PRECISION,
    "staleAt" TIMESTAMP(3) NOT NULL,
    "lastRefreshAttemptAt" TIMESTAMP(3),
    "lastRefreshSuccessAt" TIMESTAMP(3),
    "lastRefreshError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TickerQuoteCache_pkey" PRIMARY KEY ("symbol")
);

-- CreateIndex
CREATE INDEX "TickerQuoteCache_staleAt_idx" ON "TickerQuoteCache"("staleAt");

-- CreateIndex
CREATE INDEX "TickerQuoteCache_lastRefreshAttemptAt_idx" ON "TickerQuoteCache"("lastRefreshAttemptAt");
