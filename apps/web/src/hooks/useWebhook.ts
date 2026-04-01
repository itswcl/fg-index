import { useState, useCallback } from 'react';
import type { WebhookConfig } from '../types/alerts';

const STORAGE_KEY = 'fg-index-webhook';

function loadFromStorage(): WebhookConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as WebhookConfig;
  } catch {
    return null;
  }
}

interface UseWebhookReturn {
  webhook: WebhookConfig | null;
  setWebhook: (config: WebhookConfig) => void;
  clearWebhook: () => void;
}

export function useWebhook(): UseWebhookReturn {
  const [webhook, setWebhookState] = useState<WebhookConfig | null>(loadFromStorage);

  const setWebhook = useCallback((config: WebhookConfig) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      // localStorage might be unavailable (private browsing quota) — ignore
    }
    setWebhookState(config);
  }, []);

  const clearWebhook = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setWebhookState(null);
  }, []);

  return { webhook, setWebhook, clearWebhook };
}
