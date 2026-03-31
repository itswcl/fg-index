import { useState } from 'react';
import type { Alert } from '../../types/alerts';
import { AlertForm } from './AlertForm';
import { AlertItem } from './AlertItem';

interface AlertsPanelProps {
  alerts: Alert[];
  onAdd: (data: Omit<Alert, 'id' | 'createdAt'>) => void;
  onUpdate: (id: string, updates: Partial<Alert>) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
  notificationPermission: NotificationPermission;
  onRequestPermission: () => Promise<void>;
  isDark: boolean;
}

type ModalState =
  | { mode: 'none' }
  | { mode: 'create' }
  | { mode: 'edit'; alert: Alert };

export function AlertsPanel({
  alerts,
  onAdd,
  onUpdate,
  onDelete,
  onToggle,
  notificationPermission,
  onRequestPermission,
  isDark,
}: AlertsPanelProps) {
  const [modal, setModal] = useState<ModalState>({ mode: 'none' });

  const borderColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.07)';
  const panelBg = isDark ? 'rgba(18,18,20,0.6)' : 'rgba(242,242,247,0.8)';
  const textColor = isDark ? '#FFFFFF' : '#000000';
  const subTextColor = '#8E8E93';
  const accentColor = '#007AFF';

  const handleCreate = (data: Omit<Alert, 'id' | 'createdAt'>) => {
    onAdd(data);
    setModal({ mode: 'none' });
  };

  const handleEdit = (data: Omit<Alert, 'id' | 'createdAt'>) => {
    if (modal.mode !== 'edit') return;
    onUpdate(modal.alert.id, data);
    setModal({ mode: 'none' });
  };

  return (
    <div
      style={{
        background: panelBg,
        border: `1.5px solid ${borderColor}`,
        borderRadius: 20,
        padding: '14px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            fontSize: 9,
            fontWeight: 800,
            color: subTextColor,
            textTransform: 'uppercase',
            letterSpacing: 1.5,
            flex: 1,
          }}
        >
          Alerts
        </span>

        {/* Notification bell */}
        {notificationPermission !== 'granted' && (
          <button
            type="button"
            onClick={onRequestPermission}
            title={
              notificationPermission === 'denied'
                ? 'Notifications blocked — enable in browser settings'
                : 'Enable browser notifications'
            }
            style={{
              background: 'transparent',
              border: 'none',
              cursor: notificationPermission === 'denied' ? 'not-allowed' : 'pointer',
              fontSize: 14,
              padding: '2px 4px',
              lineHeight: 1,
              opacity: notificationPermission === 'denied' ? 0.4 : 0.7,
              transition: 'opacity 0.15s',
            }}
            aria-label="Enable notifications"
          >
            🔔
          </button>
        )}
        {notificationPermission === 'granted' && (
          <span style={{ fontSize: 13, opacity: 0.6 }} title="Notifications enabled">
            🔔
          </span>
        )}

        {/* New alert button */}
        <button
          type="button"
          onClick={() => setModal({ mode: 'create' })}
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: '#FFFFFF',
            background: accentColor,
            border: 'none',
            borderRadius: 8,
            padding: '4px 10px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'opacity 0.15s',
          }}
        >
          + New
        </button>
      </div>

      {/* Permission prompt */}
      {notificationPermission === 'default' && (
        <div
          style={{
            background: isDark ? 'rgba(0,122,255,0.12)' : 'rgba(0,122,255,0.08)',
            border: '1px solid rgba(0,122,255,0.25)',
            borderRadius: 10,
            padding: '8px 10px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ fontSize: 10, color: textColor, flex: 1 }}>
            Enable browser notifications to get alerted when conditions trigger.
          </span>
          <button
            type="button"
            onClick={onRequestPermission}
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: '#FFFFFF',
              background: accentColor,
              border: 'none',
              borderRadius: 6,
              padding: '4px 10px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              whiteSpace: 'nowrap',
            }}
          >
            Allow
          </button>
        </div>
      )}

      {/* Modal: create or edit */}
      {modal.mode !== 'none' && (
        <AlertForm
          initial={modal.mode === 'edit' ? modal.alert : undefined}
          onSubmit={modal.mode === 'edit' ? handleEdit : handleCreate}
          onCancel={() => setModal({ mode: 'none' })}
          isDark={isDark}
        />
      )}

      {/* Alert list */}
      {alerts.length === 0 && modal.mode === 'none' ? (
        <p
          style={{
            fontSize: 11,
            color: subTextColor,
            textAlign: 'center',
            padding: '10px 0 4px',
            lineHeight: 1.5,
          }}
        >
          No alerts yet. Create one to get notified when market conditions match.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {alerts.map((alert) => (
            <AlertItem
              key={alert.id}
              alert={alert}
              onToggle={onToggle}
              onEdit={(a) => setModal({ mode: 'edit', alert: a })}
              onDelete={onDelete}
              isDark={isDark}
            />
          ))}
        </div>
      )}
    </div>
  );
}
