import type { Alert } from '../../types/alerts';
import { AlertForm } from './AlertForm';
import { AlertItem } from './AlertItem';
import { WebhookList } from './WebhookList';
import { useWebhooks } from '../../hooks/useWebhooks';
import { useState } from 'react';

interface AlertsPanelProps {
  alerts: Alert[];
  onAdd: (data: Omit<Alert, 'id' | 'createdAt'>) => void;
  onUpdate: (id: string, updates: Partial<Alert>) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
  isDark: boolean;
  /** When true, strips the outer card border/background — the popup provides its own container */
  inPopup?: boolean;
  /** When provided, renders a × close button at the end of the header row */
  onClose?: () => void;
}

type ViewState =
  | { view: 'list' }
  | { view: 'create' }
  | { view: 'edit'; alert: Alert }
  | { view: 'webhooks' };

export function AlertsPanel({
  alerts,
  onAdd,
  onUpdate,
  onDelete,
  onToggle,
  isDark,
  inPopup = false,
  onClose,
}: AlertsPanelProps) {
  const [viewState, setViewState] = useState<ViewState>({ view: 'list' });
  // Header indicator — React Query dedupes with the list view's own call.
  const { webhooks } = useWebhooks();
  const activeWebhookCount = webhooks.filter((w) => w.enabled).length;

  const borderColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.07)';
  const panelBg = isDark ? 'rgba(18,18,20,0.6)' : 'rgba(242,242,247,0.8)';
  const subTextColor = '#8E8E93';
  const accentColor = '#007AFF';

  const isFormMode = viewState.view !== 'list';

  const handleCreate = (data: Omit<Alert, 'id' | 'createdAt'>) => {
    onAdd(data);
    setViewState({ view: 'list' });
  };

  const handleEdit = (data: Omit<Alert, 'id' | 'createdAt'>) => {
    if (viewState.view !== 'edit') return;
    onUpdate(viewState.alert.id, data);
    setViewState({ view: 'list' });
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
        // Adaptive height: constrained in list mode, auto in form mode
        maxHeight: inPopup
          ? (isFormMode ? '90dvh' : '420px')
          : 'calc(100dvh - 520px)',
        overflow: 'hidden',
        transition: inPopup ? 'max-height 200ms ease-out' : undefined,
      }}
    >
      {/* ── Header — always visible ─────────────────────────────── */}
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

        {/* Webhooks button — acts as view switcher. Green dot ⇒ ≥1 enabled. */}
        <button
          type="button"
          onClick={() =>
            setViewState((v) => (v.view === 'webhooks' ? { view: 'list' } : { view: 'webhooks' }))
          }
          title={
            activeWebhookCount > 0
              ? `${activeWebhookCount} webhook${activeWebhookCount === 1 ? '' : 's'} enabled`
              : 'Configure webhook notifications'
          }
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: viewState.view === 'webhooks' ? '#FFFFFF' : subTextColor,
            background:
              viewState.view === 'webhooks'
                ? accentColor
                : isDark
                  ? 'rgba(255,255,255,0.07)'
                  : 'rgba(0,0,0,0.05)',
            border: `1px solid ${viewState.view === 'webhooks' ? accentColor : borderColor}`,
            borderRadius: 8,
            padding: '4px 10px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'all 0.15s',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {activeWebhookCount > 0 && (
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
          ⚡ Webhooks
        </button>

        {/* + New button — only meaningful in list view */}
        {viewState.view === 'list' && (
          <button
            type="button"
            onClick={() => setViewState({ view: 'create' })}
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
        )}

        {/* × close button — only in popup */}
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
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = isDark
                ? 'rgba(255,255,255,0.08)'
                : 'rgba(0,0,0,0.06)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
            }}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {/* ── Body — one view at a time ───────────────────────────── */}

      {/* Webhooks view */}
      {viewState.view === 'webhooks' && (
        <div style={{ overflowY: 'auto', minHeight: 0 }}>
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
            <WebhookList isDark={isDark} />
          </div>
        </div>
      )}

      {/* Create view */}
      {viewState.view === 'create' && (
        <div style={{ overflowY: 'auto', minHeight: 0 }}>
          <AlertForm
            onSubmit={handleCreate}
            onCancel={() => setViewState({ view: 'list' })}
            isDark={isDark}
          />
        </div>
      )}

      {/* Edit view */}
      {viewState.view === 'edit' && (
        <div style={{ overflowY: 'auto', minHeight: 0 }}>
          <AlertForm
            initial={viewState.alert}
            onSubmit={handleEdit}
            onCancel={() => setViewState({ view: 'list' })}
            isDark={isDark}
          />
        </div>
      )}

      {/* List view */}
      {viewState.view === 'list' && (
        <div
          style={{
            overflowY: 'auto',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {alerts.length === 0 ? (
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
                  onEdit={(a) => setViewState({ view: 'edit', alert: a })}
                  onDelete={onDelete}
                  isDark={isDark}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
