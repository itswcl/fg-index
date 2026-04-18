import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { authFetch } from '../lib/authFetch';
import { API_BASE_URL } from '../constants';
import type {
  CreateWebhookInput,
  UpdateWebhookInput,
  Webhook,
} from '../types/webhooks';

/**
 * Multi-webhook hook — mirrors the pattern in `useAlerts` / `usePreferencesSync`:
 *
 *  - React Query caches the list per user, with `staleTime: Infinity` so an
 *    alert trigger doesn't cause a refetch (see PR #77).
 *  - Mutations manually invalidate the cache on success.
 *  - Errors bubble out via `window.alert(...)` for save/delete (matching the
 *    PR #73 fail-loud pattern) and as a structured `{ ok, error }` return from
 *    `testWebhook` so the caller can render inline feedback.
 *
 * TODO(backend-contract): once `feat/multi-webhooks-api` lands, re-run the
 * manual test plan in the PR description to make sure the endpoint contracts
 * match. If the shape drifts (e.g. `enabled` default, soft-delete, URL
 * validation regex), update `types/webhooks.ts` in lockstep.
 */

const WEBHOOKS_QUERY_KEY = ['webhooks'] as const;

async function parseErrorBody(res: Response, fallback: string): Promise<string> {
  try {
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const body = (await res.json()) as { error?: string; message?: string };
      return body.error ?? body.message ?? fallback;
    }
    const text = await res.text();
    return text.slice(0, 300) || fallback;
  } catch {
    return fallback;
  }
}

export interface TestResult {
  ok: boolean;
  error?: string;
}

export interface UseWebhooksReturn {
  webhooks: Webhook[];
  isAnonymous: boolean;
  isLoading: boolean;
  createWebhook: (input: CreateWebhookInput) => Promise<Webhook>;
  updateWebhook: (id: string, input: UpdateWebhookInput) => Promise<Webhook>;
  deleteWebhook: (id: string) => Promise<void>;
  toggleWebhook: (id: string, enabled: boolean) => Promise<Webhook>;
  testWebhook: (id: string) => Promise<TestResult>;
  isMutating: boolean;
}

export function useWebhooks(): UseWebhooksReturn {
  const { user, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const isAnonymous = !authLoading && !user;
  const userId = user?.id ?? null;
  const queryKey = [...WEBHOOKS_QUERY_KEY, userId] as const;

  const query = useQuery<Webhook[]>({
    queryKey,
    enabled: !!userId,
    queryFn: async () => {
      const res = await authFetch(`${API_BASE_URL}/api/webhooks`);
      if (!res.ok) {
        throw new Error(await parseErrorBody(res, `Failed to load webhooks (${res.status})`));
      }
      const data = (await res.json()) as { webhooks: Webhook[] } | Webhook[];
      // Tolerate either `{webhooks:[…]}` envelope or raw array — align with BE.
      return Array.isArray(data) ? data : data.webhooks;
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  // ── create ────────────────────────────────────────────────────────
  const createMut = useMutation<Webhook, Error, CreateWebhookInput>({
    mutationFn: async (input) => {
      const res = await authFetch(`${API_BASE_URL}/api/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        throw new Error(await parseErrorBody(res, `Failed to create webhook (${res.status})`));
      }
      const body = (await res.json()) as { webhook: Webhook } | Webhook;
      return 'webhook' in body ? body.webhook : body;
    },
    onSuccess: invalidate,
  });

  // ── update (including toggle) ─────────────────────────────────────
  const updateMut = useMutation<Webhook, Error, { id: string; input: UpdateWebhookInput }>({
    mutationFn: async ({ id, input }) => {
      const res = await authFetch(`${API_BASE_URL}/api/webhooks/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        throw new Error(await parseErrorBody(res, `Failed to update webhook (${res.status})`));
      }
      const body = (await res.json()) as { webhook: Webhook } | Webhook;
      return 'webhook' in body ? body.webhook : body;
    },
    onMutate: async ({ id, input }) => {
      // Optimistic toggle: if only `enabled` is being flipped, patch the cache
      // immediately so the switch feels instant. Any validation error rolls
      // back via onError → invalidate.
      if (Object.keys(input).length === 1 && 'enabled' in input) {
        await queryClient.cancelQueries({ queryKey });
        const previous = queryClient.getQueryData<Webhook[]>(queryKey);
        if (previous) {
          queryClient.setQueryData<Webhook[]>(
            queryKey,
            previous.map((w) => (w.id === id ? { ...w, enabled: !!input.enabled } : w)),
          );
        }
        return { previous };
      }
      return undefined;
    },
    onError: (_err, _vars, ctx) => {
      const previous = (ctx as { previous?: Webhook[] } | undefined)?.previous;
      if (previous) queryClient.setQueryData(queryKey, previous);
      invalidate();
    },
    onSuccess: invalidate,
  });

  // ── delete ────────────────────────────────────────────────────────
  const deleteMut = useMutation<void, Error, string>({
    mutationFn: async (id) => {
      const res = await authFetch(`${API_BASE_URL}/api/webhooks/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(await parseErrorBody(res, `Failed to delete webhook (${res.status})`));
      }
    },
    onSuccess: invalidate,
  });

  // ── test (no-cache; doesn't mutate list) ──────────────────────────
  const testMut = useMutation<TestResult, Error, string>({
    mutationFn: async (id) => {
      const res = await authFetch(
        `${API_BASE_URL}/api/webhooks/${encodeURIComponent(id)}/test`,
        { method: 'POST' },
      );
      // BE returns a structured {ok,error?} body so the FE can show inline
      // feedback without relying on the HTTP status code alone.
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        const body = (await res.json()) as TestResult;
        return { ok: !!body.ok, error: body.error };
      }
      return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
    },
  });

  const createWebhook = useCallback(
    (input: CreateWebhookInput) => createMut.mutateAsync(input),
    [createMut],
  );

  const updateWebhook = useCallback(
    (id: string, input: UpdateWebhookInput) => updateMut.mutateAsync({ id, input }),
    [updateMut],
  );

  const deleteWebhook = useCallback((id: string) => deleteMut.mutateAsync(id), [deleteMut]);

  const toggleWebhook = useCallback(
    (id: string, enabled: boolean) => updateMut.mutateAsync({ id, input: { enabled } }),
    [updateMut],
  );

  const testWebhook = useCallback(
    (id: string) => testMut.mutateAsync(id),
    [testMut],
  );

  return {
    webhooks: user ? (query.data ?? []) : [],
    isAnonymous,
    isLoading: !!user && query.isLoading,
    createWebhook,
    updateWebhook,
    deleteWebhook,
    toggleWebhook,
    testWebhook,
    isMutating:
      createMut.isPending ||
      updateMut.isPending ||
      deleteMut.isPending ||
      testMut.isPending,
  };
}
