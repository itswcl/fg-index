import { useState } from 'react';
import { MAX_CUSTOM_TICKERS } from '../constants';

const STORAGE_KEY = 'fg-unified-order';
const OLD_CARD_KEY = 'fg-card-order';
const OLD_TICKER_KEY = 'fg-index-tickers';

export const DEFAULT_CARD_IDS = ['feargreed', 'vix', 'btc', 'spx'] as const;
type DefaultId = (typeof DEFAULT_CARD_IDS)[number];

function isDefaultId(id: string): id is DefaultId {
  return (DEFAULT_CARD_IDS as readonly string[]).includes(id);
}

/**
 * Load order from localStorage, migrating from old separate keys if needed.
 */
function loadOrder(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as string[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Ensure all 4 defaults are present (defensive)
        const missing = DEFAULT_CARD_IDS.filter((id) => !parsed.includes(id));
        return [...missing, ...parsed];
      }
    }

    // Migrate from old keys
    let defaults: string[] = [...DEFAULT_CARD_IDS];
    const oldCards = localStorage.getItem(OLD_CARD_KEY);
    if (oldCards) {
      try {
        const parsed = JSON.parse(oldCards) as string[];
        if (
          Array.isArray(parsed) &&
          parsed.length === 4 &&
          parsed.every((id) => isDefaultId(id))
        ) {
          defaults = parsed;
        }
      } catch {
        // ignore
      }
    }

    let tickers: string[] = [];
    const oldTickers = localStorage.getItem(OLD_TICKER_KEY);
    if (oldTickers) {
      try {
        const parsed = JSON.parse(oldTickers) as string[];
        if (Array.isArray(parsed)) tickers = parsed;
      } catch {
        // ignore
      }
    }

    return [...defaults, ...tickers];
  } catch {
    return [...DEFAULT_CARD_IDS];
  }
}

export function useUnifiedOrder() {
  const [order, setOrderState] = useState<string[]>(loadOrder);

  function save(newOrder: string[]) {
    setOrderState(newOrder);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newOrder));
      // Keep old keys in sync for backward compat
      localStorage.setItem(
        OLD_CARD_KEY,
        JSON.stringify(newOrder.filter((id) => isDefaultId(id))),
      );
      localStorage.setItem(
        OLD_TICKER_KEY,
        JSON.stringify(newOrder.filter((id) => !isDefaultId(id))),
      );
    } catch {
      // ignore
    }
  }

  /** Replace the entire order (used by drag-and-drop). */
  function reorder(newOrder: string[]) {
    save(newOrder);
  }

  /** Add a custom ticker. Returns error if validation fails. */
  function addTicker(raw: string): { ok: boolean; error?: string } {
    const normalized = raw.trim().toUpperCase();
    if (!normalized) return { ok: false, error: 'Enter a ticker' };
    if (order.includes(normalized)) return { ok: false, error: 'Already added' };
    const tickerCount = order.filter((id) => !isDefaultId(id)).length;
    if (tickerCount >= MAX_CUSTOM_TICKERS)
      return { ok: false, error: `Maximum ${MAX_CUSTOM_TICKERS} tickers` };
    save([...order, normalized]);
    return { ok: true };
  }

  /** Remove a custom ticker. Default cards cannot be removed. */
  function removeTicker(ticker: string) {
    if (isDefaultId(ticker)) return;
    save(order.filter((t) => t !== ticker));
  }

  /** Custom tickers (non-default IDs) in their current order. */
  const tickers = order.filter((id) => !isDefaultId(id));

  return { order, reorder, addTicker, removeTicker, tickers };
}
