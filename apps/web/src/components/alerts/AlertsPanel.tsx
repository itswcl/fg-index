import { useState } from 'react';
import type { Alert, WebhookConfig } from '../../types/alerts';
import { AlertForm } from './AlertForm';
import { AlertItem } from './AlertItem';
import { WebhookForm } from './WebhookForm';

interface AlertsPanelProps {
  alerts: Alert[];
  onAdd: (data: Omit<Alert, 'id' | 'createdAt'>) => void;
  onUpdate: (id: string, updates: Partial<Alert>) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
  webhook: WebhookConfig | null;
  onSaveWebhook: (cfg: WebhookConfig) => void;
  onRemoveWebhook: () => void;
  isDark: boolean;
  /** When true, strips the outer card border/background — the popup provides its own container */
  inPopup?: boolean;
  /** When provided, renders a × close button at the end of the header row */
  onClose?: () => void;
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
  webhook,
  onSaveWebhook,
  onRemoveWebhook,
  isDark,
  inPopup = false,
  onClose,
}: AlertsPanelProps) {
  const [modal, setModal] = useState<ModalState>({ mode: 'none' });
  const [webhookOpen, setWebhookOpen] = useState(false);

  const borderColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.07)';
  const panelBg = isDark ? 'rgba(18,18,20,0.6)' : 'rgba(242,242,247,0.8)';
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
        background: inPopup ? 'transparent' : panelBg,
        border: inPopup ? 'none' : `1.5px solid ${borderColor}`,
        borderRadius: inPopup ? 0 : 20,
        padding: '14px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        maxHeight: 'calc(100dvh - 520px)',
        overflow: 'hidden',
      }}
    >
      {/* Header — always visible, never scrolls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
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

        {/* Webhook toggle button */}
        <button
          type="button"
          onClick={() => setWebhookOpen((o) => !o)}
          title={webhook ? 'Webhook configured' : 'Configure webhook notifications'}
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: webhookOpen ? '#FFFFFF' : subTextColor,
            background: webhookOpen
              ? accentColor
              : isDark
                ? 'rgba(255,255,255,0.07)'
                : 'rgba(0,0,0,0.05)',
            border: `1px solid ${webhookOpen ? accentColor : borderColor}`,
            borderRadius: 8,
            padding: '4px 9px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'all 0.15s',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {webhook && (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: '#34C759',
                display: 'inline-block',
                flexShrink: 0,
              }}
            />
          )}
          ⚡ Webhook
        </button>

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

        {/* Close button — only rendered inside popup */}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close alerts"
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: isDark ? 'rgba(255,255,255,0.40)' : 'rgba(0,0,0,0.35)',
              flexShrink: 0,
              transition: 'background 150ms ease',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLButtonElement).style.background = isDark
                ? 'rgba(255,255,255,0.08)'
                : 'rgba(0,0,0,0.06)';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {/* Scrollable body — webhook panel + form + list all scroll together */}
      <div style={{ overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Webhook section (collapsible) */}
      {webhookOpen && (
        <div
          style={{
            background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
            border: `1px solid ${borderColor}`,
            borderRadius: 12,
            padding: '12px 12px',
          }}
        >
          <span
            style={{
              fontSize: 9,
              fontWeight: 800,
              color: subTextColor,
              textTransform: 'uppercase',
              letterSpacing: 1.5,
              display: 'block',
              marginBottom: 10,
            }}
          >
            Webhook Notifications
          </span>
          <WebhookForm
            webhook={webhook}
            onSave={(cfg) => {
              onSaveWebhook(cfg);
              setWebhookOpen(false);
            }}
            onRemove={() => {
              onRemoveWebhook();
              setWebhookOpen(false);
            }}
            isDark={isDark}
          />
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

      </div>{/* end scrollable body */}
    </div>
  );
}
