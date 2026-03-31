import { useState, useCallback } from 'react';
import type { Alert } from '../types/alerts';

const STORAGE_KEY = 'fg-index-alerts';

function loadFromStorage(): Alert[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Basic validation: filter out entries missing required fields
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

function saveToStorage(alerts: Alert[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts));
  } catch {
    // Storage full or unavailable — fail silently
  }
}

interface UseAlertsReturn {
  alerts: Alert[];
  addAlert: (alert: Omit<Alert, 'id' | 'createdAt'>) => void;
  updateAlert: (id: string, updates: Partial<Alert>) => void;
  deleteAlert: (id: string) => void;
  toggleAlert: (id: string) => void;
}

export function useAlerts(): UseAlertsReturn {
  const [alerts, setAlerts] = useState<Alert[]>(() => loadFromStorage());

  const addAlert = useCallback((alert: Omit<Alert, 'id' | 'createdAt'>) => {
    const newAlert: Alert = {
      ...alert,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    setAlerts((prev) => {
      const next = [...prev, newAlert];
      saveToStorage(next);
      return next;
    });
  }, []);

  const updateAlert = useCallback((id: string, updates: Partial<Alert>) => {
    setAlerts((prev) => {
      const next = prev.map((a) => (a.id === id ? { ...a, ...updates } : a));
      saveToStorage(next);
      return next;
    });
  }, []);

  const deleteAlert = useCallback((id: string) => {
    setAlerts((prev) => {
      const next = prev.filter((a) => a.id !== id);
      saveToStorage(next);
      return next;
    });
  }, []);

  const toggleAlert = useCallback((id: string) => {
    setAlerts((prev) => {
      const next = prev.map((a) =>
        a.id === id ? { ...a, enabled: !a.enabled } : a,
      );
      saveToStorage(next);
      return next;
    });
  }, []);

  return { alerts, addAlert, updateAlert, deleteAlert, toggleAlert };
}
