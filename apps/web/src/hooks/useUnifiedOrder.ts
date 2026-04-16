import { useEffect, useMemo, useState } from 'react';
import { useTickerList } from './useTickerList';

const STORAGE_KEY = 'fg-unified-order';
const OLD_CARD_KEY = 'fg-card-order';
const OLD_TICKER_KEY = 'fg-index-tickers';

export const DEFAULT_CARD_IDS = ['feargreed', 'vix', 'btc', 'spx'] as const;
type DefaultId = (typeof DEFAULT_CARD_IDS)[number];

function isDefaultId(id: string): id is DefaultId {
  return (DEFAULT_CARD_IDS as readonly string[]).includes(id);
}

/**
 * Load the persisted card-order (defaults + ticker positions) from
 * localStorage, migrating from older split keys if present. Card order
 * itself stays local for now — PR 4 will server-persist it.
 */
function loadOrder(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as string[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        const missing = DEFAULT_CARD_IDS.filter((id) => !parsed.includes(id));
        return [...missing, ...parsed];
      }
    }

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
    return [...defaults];
  } catch {
    return [...DEFAULT_CARD_IDS];
  }
}

function saveOrder(order: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
    localStorage.setItem(
      OLD_CARD_KEY,
      JSON.stringify(order.filter((id) => isDefaultId(id))),
    );
    localStorage.setItem(
      OLD_TICKER_KEY,
      JSON.stringify(order.filter((id) => !isDefaultId(id))),
    );
  } catch {
    // ignore
  }
}

export function useUnifiedOrder() {
  const { tickers, addTicker, removeTicker, reorderTickers } = useTickerList();
  const [baseOrder, setBaseOrder] = useState<string[]>(loadOrder);

  // Reconcile the locally-remembered order with the authoritative ticker list
  // returned by useTickerList (server-backed for signed-in users, localStorage
  // for anonymous). Unknown tickers get dropped, new ones append at the end,
  // and the existing positions for known ids are preserved.
  const order = useMemo(() => {
    const tickerSet = new Set(tickers);
    const kept = baseOrder.filter((id) => isDefaultId(id) || tickerSet.has(id));
    for (const id of DEFAULT_CARD_IDS) {
      if (!kept.includes(id)) kept.unshift(id);
    }
    for (const t of tickers) {
      if (!kept.includes(t)) kept.push(t);
    }
    return kept;
  }, [baseOrder, tickers]);

  // Persist the reconciled order so a subsequent reload doesn't reintroduce
  // removed tickers or lose the intended position of new ones.
  useEffect(() => {
    saveOrder(order);
  }, [order]);

  /** Replace the entire order (drag-and-drop). Also persists ticker order. */
  function reorder(newOrder: string[]) {
    setBaseOrder(newOrder);
    const newTickerOrder = newOrder.filter((id) => !isDefaultId(id));
    const prevTickerOrder = tickers;
    const changed =
      newTickerOrder.length !== prevTickerOrder.length ||
      newTickerOrder.some((t, i) => prevTickerOrder[i] !== t);
    if (changed) reorderTickers(newTickerOrder);
  }

  return { order, reorder, addTicker, removeTicker, tickers };
}
