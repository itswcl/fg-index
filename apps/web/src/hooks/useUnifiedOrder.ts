import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL } from '../constants';
import { authFetch } from '../lib/authFetch';
import { useAuth } from './useAuth';
import { useTickerList } from './useTickerList';

const STORAGE_KEY = 'fg-unified-order';
const OLD_CARD_KEY = 'fg-card-order';
const OLD_TICKER_KEY = 'fg-index-tickers';
const PUT_DEBOUNCE_MS = 500;

export const DEFAULT_CARD_IDS = ['feargreed', 'vix', 'btc', 'spx'] as const;
type DefaultId = (typeof DEFAULT_CARD_IDS)[number];

function isDefaultId(id: string): id is DefaultId {
  return (DEFAULT_CARD_IDS as readonly string[]).includes(id);
}

/**
 * Load the locally-persisted card order, migrating from older split keys if
 * present. Used as the anonymous fallback and as the migration source for
 * the first server sync.
 */
function loadLocalOrder(): string[] {
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

function saveLocalOrder(order: string[]) {
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

export function clearLocalOrder(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(OLD_CARD_KEY);
  } catch {
    // ignore
  }
}

export function useUnifiedOrder() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { tickers, addTicker, removeTicker, reorderTickers } = useTickerList();

  const userId = user?.id ?? null;
  const prefsKey = useMemo(() => ['preferences', userId] as const, [userId]);

  // ── Server preferences (cardOrder) ───────────────────────────────
  const prefsQuery = useQuery<string[]>({
    queryKey: prefsKey,
    enabled: !!userId,
    queryFn: async () => {
      const res = await authFetch(`${API_BASE_URL}/api/user/preferences`);
      if (!res.ok) throw new Error(`Failed to load preferences (${res.status})`);
      const data = (await res.json()) as { cardOrder: string[] };
      return data.cardOrder ?? [];
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // Local state for the raw order (pre-reconciliation). Signed-in users
  // hydrate from the server once the query lands; signed-out users stick
  // with localStorage.
  const [baseOrder, setBaseOrder] = useState<string[]>(() =>
    user ? [...DEFAULT_CARD_IDS] : loadLocalOrder(),
  );

  // Hydrate from server on login / successful fetch.
  useEffect(() => {
    if (!user) return;
    if (!prefsQuery.isSuccess) return;
    const server = prefsQuery.data ?? [];
    if (server.length > 0) {
      setBaseOrder(server);
    } else {
      setBaseOrder([...DEFAULT_CARD_IDS]);
    }
  }, [user, prefsQuery.isSuccess, prefsQuery.data]);

  // Reset to localStorage on sign-out.
  const wasAuthedRef = useRef<boolean>(!!user);
  useEffect(() => {
    const isAuthed = !!user;
    if (wasAuthedRef.current && !isAuthed) {
      setBaseOrder(loadLocalOrder());
    }
    wasAuthedRef.current = isAuthed;
  }, [user]);

  // Reconcile against the authoritative ticker list. Drops unknown tickers,
  // appends new ones, guarantees all defaults are present.
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

  // Persist reconciled order for anonymous users (mirrors pre-refactor behavior).
  useEffect(() => {
    if (user) return;
    saveLocalOrder(order);
  }, [user, order]);

  // ── Debounced PUT to /api/user/preferences ───────────────────────
  const putMut = useMutation({
    mutationFn: async (cardOrder: string[]) => {
      const res = await authFetch(`${API_BASE_URL}/api/user/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardOrder }),
      });
      if (!res.ok) throw new Error(`Failed to save preferences (${res.status})`);
      const data = (await res.json()) as { cardOrder: string[] };
      return data.cardOrder;
    },
    onSuccess: (serverOrder) => {
      queryClient.setQueryData<string[]>(prefsKey, serverOrder);
    },
    onError: (err) => {
      // eslint-disable-next-line no-console
      console.error('[preferences] save failed:', err);
      void queryClient.invalidateQueries({ queryKey: prefsKey });
    },
  });

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleServerSave = useCallback(
    (next: string[]) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        putMut.mutate(next);
      }, PUT_DEBOUNCE_MS);
    },
    [putMut],
  );
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  /** Replace the entire order (drag-and-drop). Persists ticker order too. */
  const reorder = useCallback(
    (newOrder: string[]) => {
      setBaseOrder(newOrder);
      if (user) scheduleServerSave(newOrder);

      const newTickerOrder = newOrder.filter((id) => !isDefaultId(id));
      const prevTickerOrder = tickers;
      const changed =
        newTickerOrder.length !== prevTickerOrder.length ||
        newTickerOrder.some((t, i) => prevTickerOrder[i] !== t);
      if (changed) reorderTickers(newTickerOrder);
    },
    [user, scheduleServerSave, tickers, reorderTickers],
  );

  return { order, reorder, addTicker, removeTicker, tickers };
}
