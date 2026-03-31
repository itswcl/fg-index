import { useState, useCallback } from 'react';

interface UseNotificationsReturn {
  permission: NotificationPermission;
  requestPermission: () => Promise<void>;
  notify: (title: string, body: string) => void;
}

const isSupported = typeof window !== 'undefined' && 'Notification' in window;

export function useNotifications(): UseNotificationsReturn {
  const [permission, setPermission] = useState<NotificationPermission>(
    isSupported ? Notification.permission : 'denied',
  );

  const requestPermission = useCallback(async () => {
    if (!isSupported) return;
    if (Notification.permission === 'granted') {
      setPermission('granted');
      return;
    }
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
    } catch {
      // Some browsers throw if called outside a user gesture — ignore
    }
  }, []);

  const notify = useCallback(
    (title: string, body: string) => {
      if (!isSupported) return;
      if (Notification.permission !== 'granted') return;
      try {
        new Notification(title, { body, icon: '/favicon.ico' });
      } catch {
        // Notification creation can fail in some contexts — ignore
      }
    },
    [],
  );

  return { permission, requestPermission, notify };
}
