import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL } from '../constants';
import { authFetch } from '../lib/authFetch';
import { useAuth } from './useAuth';
import { clearLocalOrder, DEFAULT_CARD_IDS } from './useUnifiedOrder';

const STORAGE_KEY = 'fg-unified-order';
const OLD_CARD_KEY = 'fg-card-order';

function readLocalOrder(): string[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string') && parsed.length > 0) {
        return parsed as string[];
      }
    }
    const oldRaw = localStorage.getItem(OLD_CARD_KEY);
    if (oldRaw) {
      const parsed = JSON.parse(oldRaw) as unknown;
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string') && parsed.length > 0) {
        return parsed as string[];
      }
    }
    return null;
  } catch {
    return null;
  }
}

function isDefaultOrderOnly(order: string[]): boolean {
  const defaults = new Set<string>(DEFAULT_CARD_IDS);
  return order.length === defaults.size && order.every((id) => defaults.has(id));
}

/**
 * One-time migration: on first sign-in, if the server has no saved card
 * order but localStorage holds a non-default one, PUT it so the user's
 * layout carries over. Mirrors `useTickerSync`, kept separate so failures
 * in one don't block the other.
 */
export function usePreferencesSync(): void {
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
        const res = await authFetch(`${API_BASE_URL}/api/user/preferences`);
        if (!res.ok) return;
        const data = (await res.json()) as { cardOrder: string[] };
        const serverOrder = data.cardOrder ?? [];
        if (serverOrder.length > 0) {
          // Server already has a custom layout — drop stale local copy.
          clearLocalOrder();
          return;
        }
        const local = readLocalOrder();
        if (!local || isDefaultOrderOnly(local)) {
          // Nothing worth migrating — just clean up.
          clearLocalOrder();
          return;
        }

        const putRes = await authFetch(`${API_BASE_URL}/api/user/preferences`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cardOrder: local }),
        });
        if (cancelled) return;
        if (putRes.ok) {
          clearLocalOrder();
          await queryClient.invalidateQueries({ queryKey: ['preferences', user.id] });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[preferences] migration failed:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, queryClient]);
}
