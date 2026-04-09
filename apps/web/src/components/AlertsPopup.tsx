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

  const iconColor = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.40)';

  return (
    <div
      ref={ref}
      className={`alerts-popup ${isDark ? 'alerts-popup-dark' : 'alerts-popup-light'}`}
    >
      {/* Close button */}
      <button
        className={`alerts-popup-close icon-btn ${isDark ? 'icon-btn-dark' : 'icon-btn-light'}`}
        onClick={onClose}
        aria-label="Close alerts"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke={iconColor} strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

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
      />
    </div>
  );
}
