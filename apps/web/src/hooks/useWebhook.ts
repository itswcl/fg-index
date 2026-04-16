import { useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WebhookConfig } from '../types/alerts';
import { useAuth } from './useAuth';
import { authFetch } from '../lib/authFetch';
import { API_BASE_URL } from '../constants';

const STORAGE_KEY = 'fg-index-webhook';

function loadLocalWebhook(): WebhookConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WebhookConfig;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearLocalWebhook(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export interface UseWebhookReturn {
  webhook: WebhookConfig | null;
  isAnonymous: boolean;
  isLoading: boolean;
  setWebhook: (config: WebhookConfig) => void;
  clearWebhook: () => void;
}

export function useWebhook(): UseWebhookReturn {
  const { user, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;
  const isAnonymous = !authLoading && !user;

  const query = useQuery<WebhookConfig | null>({
    queryKey: ['webhook', userId],
    enabled: !!userId,
    queryFn: async () => {
      const res = await authFetch(`${API_BASE_URL}/api/webhooks/me`);
      if (!res.ok) throw new Error(`Failed to load webhook (${res.status})`);
      const data = (await res.json()) as { webhook: WebhookConfig | null };
      return data.webhook;
    },
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['webhook', userId] });
  }, [queryClient, userId]);

  async function throwFromResponse(res: Response, context: string): Promise<never> {
    let detail = '';
    try {
      const body = await res.text();
      if (body) detail = ` — ${body.slice(0, 300)}`;
    } catch {
      // ignore
    }
    throw new Error(`${context} (${res.status})${detail}`);
  }

  const reportError = (action: string) => (err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`[webhook] ${action} failed:`, err);
    const msg = err instanceof Error ? err.message : String(err);
    if (typeof window !== 'undefined') {
      window.alert(`Couldn't ${action}: ${msg}`);
    }
  };

  const putMut = useMutation({
    mutationFn: async (config: WebhookConfig) => {
      const res = await authFetch(`${API_BASE_URL}/api/webhooks/me`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook: config }),
      });
      if (!res.ok) await throwFromResponse(res, 'Failed to save webhook');
    },
    onSuccess: invalidate,
    onError: reportError('save webhook'),
  });

  const deleteMut = useMutation({
    mutationFn: async () => {
      const res = await authFetch(`${API_BASE_URL}/api/webhooks/me`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 204) {
        await throwFromResponse(res, 'Failed to delete webhook');
      }
    },
    onSuccess: invalidate,
    onError: reportError('delete webhook'),
  });

  const setWebhook = useCallback(
    (config: WebhookConfig) => {
      if (!user) return;
      putMut.mutate(config);
    },
    [user, putMut],
  );

  const clearWebhook = useCallback(() => {
    if (!user) return;
    deleteMut.mutate();
  }, [user, deleteMut]);

  // ── Auto-import from localStorage on first sign-in ─────────────
  const migrationCheckedRef = useRef(false);
  useEffect(() => {
    if (!user) {
      migrationCheckedRef.current = false;
      return;
    }
    if (migrationCheckedRef.current) return;
    if (!query.isSuccess) return;
    migrationCheckedRef.current = true;

    if (query.data != null) {
      // Server already has a webhook — legacy localStorage (if any) is stale.
      clearLocalWebhook();
      return;
    }
    const local = loadLocalWebhook();
    if (!local) return;
    // Auto-import silently: PUT then clear localStorage.
    putMut.mutate(local, {
      onSuccess: () => {
        clearLocalWebhook();
        invalidate();
      },
      onError: () => {
        // Leave localStorage in place for a retry on next load.
      },
    });
  }, [user, query.isSuccess, query.data, putMut, invalidate]);

  return {
    webhook: user ? (query.data ?? null) : null,
    isAnonymous,
    isLoading: !!user && query.isLoading,
    setWebhook,
    clearWebhook,
  };
}
