import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Alert } from '../types/alerts';
import { useAuth } from './useAuth';
import { authFetch } from '../lib/authFetch';
import { API_BASE_URL } from '../constants';

const STORAGE_KEY = 'fg-index-alerts';

// ── localStorage helpers (legacy + migration source) ──────────────
function loadLocalAlerts(): Alert[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is Alert =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as Alert).id === 'string' &&
        typeof (item as Alert).name === 'string' &&
        Array.isArray((item as Alert).conditions) &&
        typeof (item as Alert).logic === 'string' &&
        typeof (item as Alert).enabled === 'boolean' &&
        typeof (item as Alert).createdAt === 'string',
    );
  } catch {
    return [];
  }
}

function clearLocalAlerts(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

// Fields accepted by the backend when creating / updating an alert.
type AlertWritable = Omit<Alert, 'id' | 'createdAt' | 'lastTriggeredAt'>;

function stripForServer(a: Alert): AlertWritable {
  return {
    name: a.name,
    logic: a.logic,
    enabled: a.enabled,
    conditions: a.conditions,
  };
}

export interface UseAlertsReturn {
  alerts: Alert[];
  isAnonymous: boolean;
  isLoading: boolean;
  addAlert: (alert: Omit<Alert, 'id' | 'createdAt'>) => void;
  updateAlert: (id: string, updates: Partial<Alert>) => void;
  deleteAlert: (id: string) => void;
  toggleAlert: (id: string) => void;
  /** localStorage alerts detected on first sign-in; null once resolved or absent. */
  migrationCandidate: Alert[] | null;
  acceptMigration: () => Promise<void>;
  dismissMigration: () => void;
}

export function useAlerts(): UseAlertsReturn {
  const { user, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;
  const isAnonymous = !authLoading && !user;

  const alertsQuery = useQuery<Alert[]>({
    queryKey: ['alerts', userId],
    enabled: !!userId,
    queryFn: async () => {
      const res = await authFetch(`${API_BASE_URL}/api/alerts`);
      if (!res.ok) throw new Error(`Failed to load alerts (${res.status})`);
      const data = (await res.json()) as { alerts?: Alert[] };
      return data.alerts ?? [];
    },
  });

  const alerts = user ? (alertsQuery.data ?? []) : [];

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['alerts', userId] });
  }, [queryClient, userId]);

  // ── Mutations ──────────────────────────────────────────────────
  const createMut = useMutation({
    mutationFn: async (data: Omit<Alert, 'id' | 'createdAt'>) => {
      const body = stripForServer({
        ...data,
        id: '',
        createdAt: '',
      } as Alert);
      const res = await authFetch(`${API_BASE_URL}/api/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Failed to create alert (${res.status})`);
    },
    onSuccess: invalidate,
  });

  const updateMut = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<Alert> }) => {
      // Strip fields the backend doesn't accept
      const {
        id: _id,
        createdAt: _createdAt,
        lastTriggeredAt: _lastTriggeredAt,
        ...writable
      } = updates;
      void _id; void _createdAt; void _lastTriggeredAt;
      if (Object.keys(writable).length === 0) {
        // lastTriggeredAt-only updates come from WS alert_triggered;
        // the server already persists them — just refresh.
        invalidate();
        return;
      }
      const res = await authFetch(`${API_BASE_URL}/api/alerts/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(writable),
      });
      if (!res.ok) throw new Error(`Failed to update alert (${res.status})`);
    },
    onSuccess: invalidate,
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await authFetch(`${API_BASE_URL}/api/alerts/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`Failed to delete alert (${res.status})`);
      }
    },
    onSuccess: invalidate,
  });

  const addAlert = useCallback(
    (alert: Omit<Alert, 'id' | 'createdAt'>) => {
      if (!user) return;
      createMut.mutate(alert);
    },
    [user, createMut],
  );

  const updateAlert = useCallback(
    (id: string, updates: Partial<Alert>) => {
      if (!user) return;
      updateMut.mutate({ id, updates });
    },
    [user, updateMut],
  );

  const deleteAlert = useCallback(
    (id: string) => {
      if (!user) return;
      deleteMut.mutate(id);
    },
    [user, deleteMut],
  );

  const toggleAlert = useCallback(
    (id: string) => {
      if (!user) return;
      const current = alerts.find((a) => a.id === id);
      if (!current) return;
      updateMut.mutate({ id, updates: { enabled: !current.enabled } });
    },
    [user, alerts, updateMut],
  );

  // ── One-time migration from localStorage ──────────────────────
  const [migrationCandidate, setMigrationCandidate] = useState<Alert[] | null>(null);
  const migrationCheckedRef = useRef(false);

  useEffect(() => {
    if (!user) {
      migrationCheckedRef.current = false;
      setMigrationCandidate(null);
      return;
    }
    if (migrationCheckedRef.current) return;
    if (!alertsQuery.isSuccess) return;
    migrationCheckedRef.current = true;
    const serverAlerts = alertsQuery.data ?? [];
    if (serverAlerts.length > 0) return;
    const local = loadLocalAlerts();
    if (local.length > 0) setMigrationCandidate(local);
  }, [user, alertsQuery.isSuccess, alertsQuery.data]);

  const acceptMigration = useCallback(async () => {
    if (!user || !migrationCandidate) return;
    const payload = {
      alerts: migrationCandidate.map(stripForServer),
    };
    const res = await authFetch(`${API_BASE_URL}/api/alerts/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Failed to import alerts (${res.status})`);
    clearLocalAlerts();
    setMigrationCandidate(null);
    invalidate();
  }, [user, migrationCandidate, invalidate]);

  const dismissMigration = useCallback(() => {
    clearLocalAlerts();
    setMigrationCandidate(null);
  }, []);

  return {
    alerts,
    isAnonymous,
    isLoading: !!user && alertsQuery.isLoading,
    addAlert,
    updateAlert,
    deleteAlert,
    toggleAlert,
    migrationCandidate,
    acceptMigration,
    dismissMigration,
  };
}
