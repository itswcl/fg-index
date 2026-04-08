import { useState } from 'react';

export type CardId = 'feargreed' | 'vix' | 'btc' | 'spx';

const DEFAULT_ORDER: CardId[] = ['feargreed', 'vix', 'btc', 'spx'];
const STORAGE_KEY = 'fg-card-order';

function loadOrder(): CardId[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.length === 4 &&
        parsed.every(id => DEFAULT_ORDER.includes(id as CardId))
      ) {
        return parsed as CardId[];
      }
    }
  } catch {
    // ignore
  }
  return DEFAULT_ORDER;
}

export function useCardOrder() {
  const [order, setOrderState] = useState<CardId[]>(loadOrder);

  const setOrder = (newOrder: CardId[]) => {
    setOrderState(newOrder);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newOrder));
    } catch {
      // ignore
    }
  };

  return { order, setOrder };
}
