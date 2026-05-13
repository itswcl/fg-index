import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL, MAX_CUSTOM_TICKERS, TICKER_STORAGE_KEY } from '../constants';
import { authFetch } from '../lib/authFetch';
import { useAuth } from './useAuth';
import { DEFAULT_CARD_IDS } from './useUnifiedOrder';
import { MAX_CUSTOM_TICKER_GROUPS } from '../../../../packages/shared-types/src/limits';

export const DEFAULT_GROUP_ID = 'default';
export const MAX_CUSTOM_GROUPS = MAX_CUSTOM_TICKER_GROUPS;
export const TICKER_GROUPS_STORAGE_KEY = 'fg-ticker-groups';

const OLD_ORDER_KEY = 'fg-unified-order';

export interface TickerGroup {
  id: string;
  name: string;
  position: number;
  isDefault: boolean;
  tickers: string[];
  createdAt: string;
  updatedAt: string;
}

type GroupUpdate = (prev: TickerGroup[]) => TickerGroup[];

interface ServerTickerGroupPayload {
  groups?: unknown;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createDefaultGroup(tickers: string[] = []): TickerGroup {
  const now = nowIso();
  return {
    id: DEFAULT_GROUP_ID,
    name: 'Default',
    position: 0,
    isDefault: true,
    tickers,
    createdAt: now,
    updatedAt: now,
  };
}

function uniqueSymbols(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const defaults = new Set<string>(DEFAULT_CARD_IDS);
  const symbols: string[] = [];

  for (const value of raw) {
    const rawSymbol = typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? (value as { symbol?: unknown }).symbol
        : null;
    if (typeof rawSymbol !== 'string') continue;
    const symbol = rawSymbol.trim().toUpperCase();
    if (!symbol || defaults.has(symbol) || symbol.startsWith('__loading-')) continue;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol);
  }

  return symbols.slice(0, MAX_CUSTOM_TICKERS);
}

function groupsFromPayload(payload: unknown): TickerGroup[] {
  const rawGroups = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? (payload as ServerTickerGroupPayload).groups
      : null;
  return normalizeGroups(rawGroups);
}

function buildMigrationPayload(groups: TickerGroup[]): {
  defaultSymbols: string[];
  groups: Array<{ name: string; symbols: string[] }>;
} {
  const normalized = normalizeGroups(groups);
  const defaultGroup = normalized.find((group) => group.isDefault);
  return {
    defaultSymbols: defaultGroup?.tickers ?? [],
    groups: normalized
      .filter((group) => !group.isDefault)
      .map((group) => ({ name: group.name, symbols: group.tickers })),
  };
}

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function readLegacyTickerOrder(): string[] {
  const order = readJson(OLD_ORDER_KEY);
  const orderSymbols = uniqueSymbols(order);
  if (orderSymbols.length > 0) return orderSymbols;
  return uniqueSymbols(readJson(TICKER_STORAGE_KEY));
}

function normalizeGroups(raw: unknown): TickerGroup[] {
  const now = nowIso();
  const incoming = Array.isArray(raw) ? raw : [];
  const normalized = incoming
    .map((item, index): TickerGroup | null => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Partial<TickerGroup>;
      const isDefault = record.isDefault === true || record.id === DEFAULT_GROUP_ID;
      const name = isDefault ? 'Default' : String(record.name ?? '').trim();
      if (!isDefault && !name) return null;
      return {
        id: String(record.id ?? (isDefault ? DEFAULT_GROUP_ID : `group-${index}`)),
        name,
        position: Number.isFinite(record.position) ? Number(record.position) : index,
        isDefault,
        tickers: uniqueSymbols(record.tickers),
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : now,
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : now,
      };
    })
    .filter((group): group is TickerGroup => !!group);

  const byId = new Map<string, TickerGroup>();
  for (const group of normalized) {
    if (!byId.has(group.id)) byId.set(group.id, group);
  }

  if (!Array.from(byId.values()).some((group) => group.isDefault)) {
    byId.set(DEFAULT_GROUP_ID, createDefaultGroup());
  }

  const defaultGroup = Array.from(byId.values()).find((group) => group.isDefault) ?? createDefaultGroup();
  const customGroups = Array.from(byId.values())
    .filter((group) => !group.isDefault)
    .sort((a, b) => a.position - b.position)
    .slice(0, MAX_CUSTOM_GROUPS)
    .map((group, index) => ({ ...group, position: index + 1 }));

  return [
    { ...defaultGroup, name: 'Default', isDefault: true, position: 0 },
    ...customGroups,
  ];
}

function loadLocalGroups(): TickerGroup[] {
  const saved = normalizeGroups(readJson(TICKER_GROUPS_STORAGE_KEY));
  const hasSavedCustom = saved.length > 1;
  const hasSavedDefaultTickers = saved[0]?.tickers.length > 0;
  if (hasSavedCustom || hasSavedDefaultTickers) return saved;

  return [createDefaultGroup(readLegacyTickerOrder())];
}

function saveLocalGroups(groups: TickerGroup[]): void {
  try {
    localStorage.setItem(TICKER_GROUPS_STORAGE_KEY, JSON.stringify(normalizeGroups(groups)));
  } catch {
    // ignore
  }
}

function validateGroupName(name: string, groups: TickerGroup[], currentGroupId?: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a group name';
  if (trimmed.length > 20) return 'Maximum 20 characters';
  if (trimmed.toLowerCase() === 'default') return 'Name already exists';
  const exists = groups.some(
    (group) => group.id !== currentGroupId && group.name.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  return exists ? 'Name already exists' : null;
}

function buildGroupId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `group-${slug || 'custom'}-${Date.now().toString(36)}`;
}

export function useTickerGroups() {
  const { user, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;
  const queryKey = useMemo(() => ['ticker-groups', userId] as const, [userId]);
  const [localGroups, setLocalGroups] = useState<TickerGroup[]>(() => loadLocalGroups());
  const didTryMigrationRef = useRef<string | null>(null);

  const groupsQuery = useQuery<TickerGroup[]>({
    queryKey,
    enabled: !!userId,
    queryFn: async () => {
      const res = await authFetch(`${API_BASE_URL}/api/user/ticker-groups`);
      if (!res.ok) throw new Error(`Failed to load ticker groups (${res.status})`);
      return groupsFromPayload(await res.json());
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });

  const serverGroups = groupsQuery.data;
  const groups = useMemo(() => {
    if (userId && serverGroups) return normalizeGroups(serverGroups);
    if (userId && authLoading) return [createDefaultGroup()];
    if (userId && groupsQuery.isLoading && !groupsQuery.error) return [createDefaultGroup()];
    return normalizeGroups(localGroups);
  }, [authLoading, groupsQuery.error, groupsQuery.isLoading, localGroups, serverGroups, userId]);

  const isLoading = authLoading || (!!userId && groupsQuery.isLoading && !serverGroups && !groupsQuery.error);

  const applyGroups = useCallback(
    (updater: GroupUpdate) => {
      if (userId && serverGroups) {
        let next: TickerGroup[] = [];
        queryClient.setQueryData<TickerGroup[]>(queryKey, (prev) => {
          next = normalizeGroups(updater(prev ?? serverGroups));
          return next;
        });
        return next;
      }

      let nextGroups: TickerGroup[] = [];
      setLocalGroups((prev) => {
        nextGroups = normalizeGroups(updater(prev));
        saveLocalGroups(nextGroups);
        return nextGroups;
      });
      return nextGroups;
    },
    [queryClient, queryKey, serverGroups, userId],
  );

  const runServer = useCallback(
    async (action: () => Promise<Response>, label: string) => {
      if (!userId || !serverGroups) return;
      try {
        const res = await action();
        if (!res.ok && res.status !== 204) throw new Error(`${res.status}`);
        await queryClient.invalidateQueries({ queryKey });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[ticker-groups] ${label} failed:`, err);
      }
    },
    [queryClient, queryKey, serverGroups, userId],
  );

  useEffect(() => {
    if (!userId || !serverGroups || didTryMigrationRef.current === userId) return;
    didTryMigrationRef.current = userId;

    const local = loadLocalGroups();
    const hasLocal = local.some((group) => group.tickers.length > 0 || !group.isDefault);
    const hasServer = serverGroups.some((group) => group.tickers.length > 0 || !group.isDefault);
    if (!hasLocal || hasServer) return;

    void runServer(
      () => authFetch(`${API_BASE_URL}/api/user/ticker-groups/migration`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildMigrationPayload(local)),
      }),
      'migrate groups',
    );
  }, [runServer, serverGroups, userId]);

  const createGroup = useCallback(
    async (name: string): Promise<{ ok: boolean; error?: string; groupId?: string }> => {
      const error = validateGroupName(name, groups);
      if (error) return { ok: false, error };
      const customCount = groups.filter((group) => !group.isDefault).length;
      if (customCount >= MAX_CUSTOM_GROUPS) return { ok: false, error: `Maximum ${MAX_CUSTOM_GROUPS} groups reached` };

      const trimmed = name.trim();
      const createdAt = nowIso();
      const optimisticGroup: TickerGroup = {
        id: buildGroupId(trimmed),
        name: trimmed,
        position: customCount + 1,
        isDefault: false,
        tickers: [],
        createdAt,
        updatedAt: createdAt,
      };

      applyGroups((prev) => [...prev, optimisticGroup]);

      if (userId && serverGroups) {
        try {
          const res = await authFetch(`${API_BASE_URL}/api/user/ticker-groups`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: trimmed }),
          });
          if (!res.ok) throw new Error(`${res.status}`);
          const nextGroups = groupsFromPayload(await res.json());
          const created = nextGroups.find(
            (group) => !group.isDefault && group.name.toLowerCase() === trimmed.toLowerCase(),
          );
          if (nextGroups.length > 0) {
            queryClient.setQueryData<TickerGroup[]>(queryKey, nextGroups);
          }
          void queryClient.invalidateQueries({ queryKey });
          return { ok: true, groupId: created?.id ?? optimisticGroup.id };
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[ticker-groups] create group failed:', err);
        }
      }

      return { ok: true, groupId: optimisticGroup.id };
    },
    [applyGroups, groups, queryClient, queryKey, serverGroups, userId],
  );

  const renameGroup = useCallback(
    async (groupId: string, name: string): Promise<{ ok: boolean; error?: string }> => {
      const group = groups.find((item) => item.id === groupId);
      if (!group || group.isDefault) return { ok: false, error: 'Name already exists' };
      const error = validateGroupName(name, groups, groupId);
      if (error) return { ok: false, error };
      const trimmed = name.trim();

      applyGroups((prev) => prev.map((item) => (
        item.id === groupId ? { ...item, name: trimmed, updatedAt: nowIso() } : item
      )));

      void runServer(
        () => authFetch(`${API_BASE_URL}/api/user/ticker-groups/${encodeURIComponent(groupId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        }),
        'rename group',
      );

      return { ok: true };
    },
    [applyGroups, groups, runServer],
  );

  const deleteGroup = useCallback(
    async (groupId: string): Promise<{ ok: boolean }> => {
      const group = groups.find((item) => item.id === groupId);
      if (!group || group.isDefault) return { ok: false };

      applyGroups((prev) => prev.filter((item) => item.id !== groupId));
      void runServer(
        () => authFetch(`${API_BASE_URL}/api/user/ticker-groups/${encodeURIComponent(groupId)}`, {
          method: 'DELETE',
        }),
        'delete group',
      );
      return { ok: true };
    },
    [applyGroups, groups, runServer],
  );

  const addTickerToGroup = useCallback(
    (groupId: string, raw: string): { ok: boolean; error?: string } => {
      const symbol = raw.trim().toUpperCase();
      if (!symbol) return { ok: false, error: 'Enter a ticker' };
      const group = groups.find((item) => item.id === groupId);
      if (!group) return { ok: false, error: 'Enter a ticker' };
      if (group.tickers.includes(symbol)) return { ok: false, error: 'Already in this group' };
      if (group.tickers.length >= MAX_CUSTOM_TICKERS) {
        return { ok: false, error: `Maximum ${MAX_CUSTOM_TICKERS} tickers` };
      }

      applyGroups((prev) => prev.map((item) => (
        item.id === groupId
          ? { ...item, tickers: [...item.tickers, symbol], updatedAt: nowIso() }
          : item
      )));

      void runServer(
        () => authFetch(`${API_BASE_URL}/api/user/ticker-groups/${encodeURIComponent(groupId)}/tickers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol }),
        }),
        'add ticker to group',
      );

      return { ok: true };
    },
    [applyGroups, groups, runServer],
  );

  const setTickerMembership = useCallback(
    (symbolRaw: string, groupId: string, shouldInclude: boolean): { ok: boolean; error?: string } => {
      const symbol = symbolRaw.trim().toUpperCase();
      const group = groups.find((item) => item.id === groupId);
      if (!symbol || !group) return { ok: false };
      const hasTicker = group.tickers.includes(symbol);
      if (shouldInclude && hasTicker) return { ok: true };
      if (shouldInclude && group.tickers.length >= MAX_CUSTOM_TICKERS) {
        return { ok: false, error: `Maximum ${MAX_CUSTOM_TICKERS} tickers` };
      }
      if (!shouldInclude && !hasTicker) return { ok: true };

      applyGroups((prev) => prev.map((item) => {
        if (item.id !== groupId) return item;
        const tickers = shouldInclude
          ? [...item.tickers, symbol]
          : item.tickers.filter((ticker) => ticker !== symbol);
        return { ...item, tickers, updatedAt: nowIso() };
      }));

      void runServer(
        () => authFetch(
          shouldInclude
            ? `${API_BASE_URL}/api/user/ticker-groups/${encodeURIComponent(groupId)}/tickers`
            : `${API_BASE_URL}/api/user/ticker-groups/${encodeURIComponent(groupId)}/tickers/${encodeURIComponent(symbol)}`,
          {
            method: shouldInclude ? 'POST' : 'DELETE',
            headers: shouldInclude ? { 'Content-Type': 'application/json' } : undefined,
            body: shouldInclude ? JSON.stringify({ symbol }) : undefined,
          },
        ),
        shouldInclude ? 'assign ticker to group' : 'remove ticker from group',
      );

      return { ok: true };
    },
    [applyGroups, groups, runServer],
  );

  const reorderGroupTickers = useCallback(
    (groupId: string, orderedIds: string[]) => {
      const tickers = uniqueSymbols(orderedIds);
      applyGroups((prev) => prev.map((group) => (
        group.id === groupId ? { ...group, tickers, updatedAt: nowIso() } : group
      )));

      void runServer(
        () => authFetch(`${API_BASE_URL}/api/user/ticker-groups/${encodeURIComponent(groupId)}/tickers`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tickers, symbols: tickers }),
        }),
        'reorder group tickers',
      );
    },
    [applyGroups, runServer],
  );

  return {
    groups,
    isLoading,
    createGroup,
    renameGroup,
    deleteGroup,
    addTickerToGroup,
    setTickerMembership,
    reorderGroupTickers,
  };
}
