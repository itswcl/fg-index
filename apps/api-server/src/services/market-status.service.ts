import type { MarketSession, TickerQuote } from "@shared/types";
import { env } from "../config/env.js";
import { prisma } from "./db.js";

type MassiveMarketStatus = {
  market?: string;
  earlyHours?: boolean;
  afterHours?: boolean;
  serverTime?: string;
  exchanges?: {
    nasdaq?: string;
    nyse?: string;
    otc?: string;
  };
};

type MarketSessionCache = {
  session: MarketSession | null;
  updatedAt: Date | null;
  serverTime: string | null;
  lastError: string | null;
  lastStatus: MassiveMarketStatus | null;
};

const CRYPTO_SYMBOLS = new Set(["BTC", "BTC-USD"]);
const cache: MarketSessionCache = {
  session: null,
  updatedAt: null,
  serverTime: null,
  lastError: null,
  lastStatus: null,
};

function isOpenStatus(status: string | undefined): boolean {
  return status?.toLowerCase() === "open";
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizeMassiveSession(status: MassiveMarketStatus): MarketSession {
  if (status.earlyHours) return "pre";
  if (status.afterHours) return "post";
  if (
    isOpenStatus(status.market) ||
    isOpenStatus(status.exchanges?.nasdaq) ||
    isOpenStatus(status.exchanges?.nyse)
  ) {
    return "regular";
  }
  return "closed";
}

function clearExtendedFields(quote: TickerQuote): TickerQuote {
  const {
    postMarketPrice: _postMarketPrice,
    postMarketChange: _postMarketChange,
    postMarketChangePercent: _postMarketChangePercent,
    preMarketPrice: _preMarketPrice,
    preMarketChange: _preMarketChange,
    preMarketChangePercent: _preMarketChangePercent,
    ...rest
  } = quote;
  return rest;
}

function clearPostFields(quote: TickerQuote): TickerQuote {
  const {
    postMarketPrice: _postMarketPrice,
    postMarketChange: _postMarketChange,
    postMarketChangePercent: _postMarketChangePercent,
    ...rest
  } = quote;
  return rest;
}

function clearPreFields(quote: TickerQuote): TickerQuote {
  const {
    preMarketPrice: _preMarketPrice,
    preMarketChange: _preMarketChange,
    preMarketChangePercent: _preMarketChangePercent,
    ...rest
  } = quote;
  return rest;
}

function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase();
}

export function getCachedMarketSession(): MarketSession | null {
  return cache.session;
}

export function getMarketStatusStats() {
  return {
    session: cache.session,
    updatedAt: cache.updatedAt,
    serverTime: cache.serverTime,
    lastError: cache.lastError,
    configured: env.MASSIVE_API_KEY.length > 0,
  };
}

export function applyGlobalMarketSessionToQuote(quote: TickerQuote): TickerQuote {
  const session = cache.session;
  if (!session || CRYPTO_SYMBOLS.has(normalizeTicker(quote.ticker))) {
    return quote;
  }

  if (session === "regular") {
    return { ...clearExtendedFields(quote), marketSession: session };
  }

  if (session === "closed") {
    if (isFinitePositiveNumber(quote.postMarketPrice)) {
      return { ...clearPreFields(quote), marketSession: "post" };
    }
    return { ...clearExtendedFields(quote), marketSession: session };
  }

  const normalized = session === "pre" ? clearPostFields(quote) : clearPreFields(quote);
  return { ...normalized, marketSession: session };
}

async function persistMarketSession(session: MarketSession): Promise<void> {
  const extendedFields =
    session === "closed"
      ? {
          preMarketPrice: null,
          preMarketChange: null,
          preMarketChangePercent: null,
        }
      : {
          postMarketPrice: null,
          postMarketChange: null,
          postMarketChangePercent: null,
          preMarketPrice: null,
          preMarketChange: null,
          preMarketChangePercent: null,
        };

  await prisma.tickerQuoteCache.updateMany({
    where: { symbol: { notIn: Array.from(CRYPTO_SYMBOLS) } },
    data: {
      marketSession: session,
      ...extendedFields,
    },
  });
}

export async function refreshMarketStatus(): Promise<MarketSession | null> {
  if (!env.MARKET_STATUS_REFRESH_ENABLED || !env.MASSIVE_API_KEY) {
    return cache.session;
  }

  try {
    const url = new URL(env.MASSIVE_MARKET_STATUS_URL);
    url.searchParams.set("apiKey", env.MASSIVE_API_KEY);
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": env.SCRAPER_USER_AGENT,
      },
    });
    if (!response.ok) {
      throw new Error(`Massive market status returned ${response.status}`);
    }

    const body = (await response.json()) as MassiveMarketStatus;
    const session = normalizeMassiveSession(body);
    cache.session = session;
    cache.updatedAt = new Date();
    cache.serverTime = body.serverTime ?? null;
    cache.lastStatus = body;
    cache.lastError = null;
    await persistMarketSession(session);
    return session;
  } catch (error) {
    cache.lastError = error instanceof Error ? error.message : String(error);
    return cache.session;
  }
}

export function __setMarketSessionForTests(session: MarketSession | null): void {
  cache.session = session;
  cache.updatedAt = session ? new Date() : null;
  cache.serverTime = null;
  cache.lastStatus = null;
  cache.lastError = null;
}

export function __normalizeMassiveSessionForTests(
  status: MassiveMarketStatus
): MarketSession {
  return normalizeMassiveSession(status);
}
