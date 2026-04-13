import { useState } from 'react';
import { MAX_CUSTOM_TICKERS, TICKER_STORAGE_KEY } from '../constants';

function loadFromStorage(): string[] {
  try {
    const stored = localStorage.getItem(TICKER_STORAGE_KEY);
    return stored ? (JSON.parse(stored) as string[]) : [];
  } catch {
    return [];
  }
}

export function useTickerList() {
  const [tickers, setTickers] = useState<string[]>(loadFromStorage);

  const save = (list: string[]) => {
    setTickers(list);
    localStorage.setItem(TICKER_STORAGE_KEY, JSON.stringify(list));
  };

  const addTicker = (raw: string): { ok: boolean; error?: string } => {
    const normalized = raw.trim().toUpperCase();
    if (!normalized) return { ok: false, error: 'Enter a ticker' };
    if (tickers.includes(normalized)) return { ok: false, error: 'Already added' };
    if (tickers.length >= MAX_CUSTOM_TICKERS) return { ok: false, error: `Maximum ${MAX_CUSTOM_TICKERS} tickers` };
    save([...tickers, normalized]);
    return { ok: true };
  };

  const removeTicker = (ticker: string) => {
    save(tickers.filter((t) => t !== ticker));
  };

  const reorderTickers = (newOrder: string[]) => {
    save(newOrder);
  };

  return { tickers, addTicker, removeTicker, reorderTickers };
}
