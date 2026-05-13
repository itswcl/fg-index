import type { TickerQuote } from "@shared/types";

export interface QuoteSymbolMapping {
  canonicalSymbol: string;
  providerSymbol: string;
  displayTicker: string;
  displayName?: string;
}

const DEFAULT_MARKET_SYMBOLS: Record<string, QuoteSymbolMapping> = {
  VIX: {
    canonicalSymbol: "VIX",
    providerSymbol: "^VIX",
    displayTicker: "VIX",
    displayName: "CBOE Volatility Index",
  },
  "^VIX": {
    canonicalSymbol: "VIX",
    providerSymbol: "^VIX",
    displayTicker: "VIX",
    displayName: "CBOE Volatility Index",
  },
  SPX: {
    canonicalSymbol: "SPX",
    providerSymbol: "^GSPC",
    displayTicker: "SPX",
    displayName: "S&P 500",
  },
  GSPC: {
    canonicalSymbol: "SPX",
    providerSymbol: "^GSPC",
    displayTicker: "SPX",
    displayName: "S&P 500",
  },
  "^GSPC": {
    canonicalSymbol: "SPX",
    providerSymbol: "^GSPC",
    displayTicker: "SPX",
    displayName: "S&P 500",
  },
  SP500: {
    canonicalSymbol: "SPX",
    providerSymbol: "^GSPC",
    displayTicker: "SPX",
    displayName: "S&P 500",
  },
  IGV: {
    canonicalSymbol: "IGV",
    providerSymbol: "IGV:BATS",
    displayTicker: "IGV",
    displayName: "iShares Expanded Tech-Software Sector ETF",
  },
  DRAM: {
    canonicalSymbol: "DRAM",
    providerSymbol: "DRAM:BATS",
    displayTicker: "DRAM",
    displayName: "Roundhill Memory ETF",
  },
  "BRK.B": {
    canonicalSymbol: "BRK.B",
    providerSymbol: "BRK.B:NYSE",
    displayTicker: "BRK.B",
    displayName: "Berkshire Hathaway Inc Class B",
  },
  "BRK-B": {
    canonicalSymbol: "BRK.B",
    providerSymbol: "BRK.B:NYSE",
    displayTicker: "BRK.B",
    displayName: "Berkshire Hathaway Inc Class B",
  },
};

export function normalizeQuoteSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  return DEFAULT_MARKET_SYMBOLS[upper]?.canonicalSymbol ?? upper;
}

export function getQuoteSymbolMapping(symbol: string): QuoteSymbolMapping {
  const upper = symbol.trim().toUpperCase();
  return (
    DEFAULT_MARKET_SYMBOLS[upper] ?? {
      canonicalSymbol: upper,
      providerSymbol: upper,
      displayTicker: upper,
    }
  );
}

export function isMappedMarketSymbol(symbol: string): boolean {
  const upper = symbol.trim().toUpperCase();
  return DEFAULT_MARKET_SYMBOLS[upper] !== undefined;
}

export function applyQuoteSymbolMapping(
  quote: TickerQuote,
  mapping: QuoteSymbolMapping
): TickerQuote {
  if (mapping.providerSymbol === mapping.canonicalSymbol) {
    return quote;
  }
  return {
    ...quote,
    ticker: mapping.displayTicker,
    ...(mapping.displayName ? { name: mapping.displayName } : {}),
  };
}
