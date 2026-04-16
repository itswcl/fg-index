import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL, MAX_CUSTOM_TICKERS, TICKER_STORAGE_KEY } from '../constants';
import { useAuth } from './useAuth';
import { authFetch } from '../lib/authFetch';

// ── localStorage helpers (anonymous fallback + migration source) ──
function loadLocalTickers(): string[] {
  try {
    const raw = localStorage.getItem(TICKER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    return [];
  }
}

function saveLocalTickers(list: string[]): void {
  try {
    localStorage.setItem(TICKER_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

export function clearLocalTickers(): void {
  try {
    localStorage.removeItem(TICKER_STORAGE_KEY);
  } catch {
    // ignore
  }
}

interface ServerTicker {
  symbol: string;
  position: number;
}

export interface UseTickerListReturn {
  tickers: string[];
  isLoading: boolean;
  addTicker: (raw: string) => { ok: boolean; error?: string };
  removeTicker: (ticker: string) => void;
  reorderTickers: (newOrder: string[]) => void;
}

export function useTickerList(): UseTickerListReturn {
  const { user, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;
  const queryKey = useMemo(() => ['tickers', userId] as const, [userId]);

  // ── Server query (authenticated only) ────────────────────────────
  const query = useQuery<string[]>({
    queryKey,
    enabled: !!userId,
    queryFn: async () => {
      const res = await authFetch(`${API_BASE_URL}/api/user/tickers`);
      if (!res.ok) throw new Error(`Failed to load tickers (${res.status})`);
      const data = (await res.json()) as { tickers: ServerTicker[] };
      return (data.tickers ?? []).map((t) => t.symbol);
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // Source of truth for the current rendered list.
  const tickers = user ? (query.data ?? []) : (authLoading ? [] : loadLocalTickers());

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const setCache = useCallback(
    (updater: (prev: string[]) => string[]) => {
      queryClient.setQueryData<string[]>(queryKey, (prev) => updater(prev ?? []));
    },
    [queryClient, queryKey],
  );

  const reportError = (action: string) => (err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`[tickers] ${action} failed:`, err);
  };

  // ── Mutations (server-backed) ────────────────────────────────────
  const addMut = useMutation({
    mutationFn: async (symbol: string) => {
      const res = await authFetch(`${API_BASE_URL}/api/user/tickers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      });
      if (!res.ok) throw new Error(`Failed to add ticker (${res.status})`);
    },
    onSuccess: invalidate,
    onError: (err) => {
      reportError('add ticker')(err);
      invalidate(); // roll back optimistic update
    },
  });

  const deleteMut = useMutation({
    mutationFn: async (symbol: string) => {
      const res = await authFetch(
        `${API_BASE_URL}/api/user/tickers/${encodeURIComponent(symbol)}`,
        { method: 'DELETE' },
      );
      if (!res.ok && res.status !== 204) {
        throw new Error(`Failed to remove ticker (${res.status})`);
      }
    },
    onSuccess: invalidate,
    onError: (err) => {
      reportError('remove ticker')(err);
      invalidate();
    },
  });

  const reorderMut = useMutation({
    mutationFn: async (symbols: string[]) => {
      const res = await authFetch(`${API_BASE_URL}/api/user/tickers`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols }),
      });
      if (!res.ok) throw new Error(`Failed to reorder tickers (${res.status})`);
    },
    onSuccess: invalidate,
    onError: (err) => {
      reportError('reorder tickers')(err);
      invalidate();
    },
  });

  // ── Public API (sync, same shape as before) ──────────────────────
  const addTicker = useCallback(
    (raw: string): { ok: boolean; error?: string } => {
      const normalized = raw.trim().toUpperCase();
      if (!normalized) return { ok: false, error: 'Enter a ticker' };
      if (tickers.includes(normalized)) return { ok: false, error: 'Already added' };
      if (tickers.length >= MAX_CUSTOM_TICKERS) {
        return { ok: false, error: `Maximum ${MAX_CUSTOM_TICKERS} tickers` };
      }

      if (user) {
        // Optimistic update — server is source of truth.
        setCache((prev) => [...prev, normalized]);
        addMut.mutate(normalized);
      } else {
        const next = [...tickers, normalized];
        saveLocalTickers(next);
        // Force re-render of anonymous consumers by invalidating (no-op when disabled).
        queryClient.setQueryData<string[]>(queryKey, next);
      }
      return { ok: true };
    },
    [user, tickers, setCache, addMut, queryClient, queryKey],
  );

  const removeTicker = useCallback(
    (ticker: string) => {
      if (user) {
        setCache((prev) => prev.filter((t) => t !== ticker));
        deleteMut.mutate(ticker);
      } else {
        const next = tickers.filter((t) => t !== ticker);
        saveLocalTickers(next);
        queryClient.setQueryData<string[]>(queryKey, next);
      }
    },
    [user, tickers, setCache, deleteMut, queryClient, queryKey],
  );

  const reorderTickers = useCallback(
    (newOrder: string[]) => {
      if (user) {
        setCache(() => newOrder);
        reorderMut.mutate(newOrder);
      } else {
        saveLocalTickers(newOrder);
        queryClient.setQueryData<string[]>(queryKey, newOrder);
      }
    },
    [user, setCache, reorderMut, queryClient, queryKey],
  );

  return {
    tickers,
    isLoading: !!user && query.isLoading,
    addTicker,
    removeTicker,
    reorderTickers,
  };
}
