import { useEffect, useRef } from 'react';
import { AlertsPanel } from './alerts';
import type { Alert } from '../types/alerts';

interface AlertsPopupProps {
  isDark: boolean;
  alerts: Alert[];
  onAdd: Parameters<typeof AlertsPanel>[0]['onAdd'];
  onUpdate: Parameters<typeof AlertsPanel>[0]['onUpdate'];
  onDelete: Parameters<typeof AlertsPanel>[0]['onDelete'];
  onToggle: Parameters<typeof AlertsPanel>[0]['onToggle'];
  webhook: Parameters<typeof AlertsPanel>[0]['webhook'];
  onSaveWebhook: Parameters<typeof AlertsPanel>[0]['onSaveWebhook'];
  onRemoveWebhook: Parameters<typeof AlertsPanel>[0]['onRemoveWebhook'];
  onClose: () => void;
}

export function AlertsPopup({
  isDark,
  alerts,
  onAdd,
  onUpdate,
  onDelete,
  onToggle,
  webhook,
  onSaveWebhook,
  onRemoveWebhook,
  onClose,
}: AlertsPopupProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className={`alerts-popup ${isDark ? 'alerts-popup-dark' : 'alerts-popup-light'}`}
    >
      <AlertsPanel
        alerts={alerts}
        onAdd={onAdd}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onToggle={onToggle}
        webhook={webhook}
        onSaveWebhook={onSaveWebhook}
        onRemoveWebhook={onRemoveWebhook}
        isDark={isDark}
        inPopup
        onClose={onClose}
      />
    </div>
  );
}
