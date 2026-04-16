import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL } from '../constants';
import { authFetch } from '../lib/authFetch';
import { useAuth } from './useAuth';
import { clearLocalTickers } from './useTickerList';

const TICKER_STORAGE_KEY = 'fg-index-tickers';

function readLocalTickers(): string[] {
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

/**
 * One-time migration: on first sign-in, if the server has no tickers for the
 * user but localStorage holds some (from pre-auth usage), bulk-PUT them so
 * the user's existing tickers carry over. Clears localStorage on success.
 *
 * Mount once near the root (after `QueryClientProvider`) alongside other
 * first-login sync hooks.
 */
export function useTickerSync(): void {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const migratedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!user) {
      migratedRef.current = null;
      return;
    }
    if (migratedRef.current === user.id) return;
    migratedRef.current = user.id;

    let cancelled = false;

    (async () => {
      try {
        const res = await authFetch(`${API_BASE_URL}/api/user/tickers`);
        if (!res.ok) return;
        const data = (await res.json()) as { tickers: { symbol: string }[] };
        const serverTickers = data.tickers ?? [];
        if (serverTickers.length > 0) {
          // Server already has tickers — local copy (if any) is stale.
          clearLocalTickers();
          return;
        }
        const local = readLocalTickers();
        if (local.length === 0) return;

        const putRes = await authFetch(`${API_BASE_URL}/api/user/tickers`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbols: local }),
        });
        if (cancelled) return;
        if (putRes.ok) {
          clearLocalTickers();
          await queryClient.invalidateQueries({ queryKey: ['tickers', user.id] });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[tickers] migration failed:', err);
        // Leave localStorage in place for a retry next load.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, queryClient]);
}
