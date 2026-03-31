import { useState } from 'react';
import type { Alert } from '../../types/alerts';
import { conditionLabel } from './AlertForm';

interface AlertItemProps {
  alert: Alert;
  onToggle: (id: string) => void;
  onEdit: (alert: Alert) => void;
  onDelete: (id: string) => void;
  isDark: boolean;
}

function formatTriggered(iso: string | undefined): string {
  if (!iso) return 'Never';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return 'Never';
  }
}

export function AlertItem({ alert, onToggle, onEdit, onDelete, isDark }: AlertItemProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const borderColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
  const cardBg = isDark ? 'rgba(28,28,30,0.85)' : 'rgba(255,255,255,0.92)';
  const textColor = isDark ? '#FFFFFF' : '#000000';
  const subTextColor = '#8E8E93';
  const accentColor = '#007AFF';
  const dangerColor = '#E74C3C';

  const conditionsSummary = alert.conditions
    .map((c) => conditionLabel(c))
    .join(` ${alert.logic} `);

  return (
    <div
      style={{
        background: cardBg,
        border: `1.5px solid ${borderColor}`,
        borderRadius: 14,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        opacity: alert.enabled ? 1 : 0.55,
        transition: 'opacity 0.2s ease',
        boxShadow: isDark
          ? '0 2px 8px rgba(0,0,0,0.3)'
          : '0 2px 6px rgba(0,0,0,0.07)',
      }}
    >
      {/* Top row: name + toggle */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: textColor,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {alert.name}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={alert.enabled}
          onClick={() => onToggle(alert.id)}
          aria-label={alert.enabled ? 'Disable alert' : 'Enable alert'}
          style={{
            width: 36,
            height: 20,
            borderRadius: 10,
            border: 'none',
            cursor: 'pointer',
            background: alert.enabled ? accentColor : (isDark ? '#3A3A3C' : '#D1D1D6'),
            position: 'relative',
            transition: 'background 0.2s ease',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: alert.enabled ? 18 : 2,
              width: 16,
              height: 16,
              borderRadius: '50%',
              background: '#FFFFFF',
              transition: 'left 0.2s ease',
              boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
            }}
          />
        </button>
      </div>

      {/* Conditions summary */}
      <span
        style={{
          fontSize: 11,
          color: subTextColor,
          fontWeight: 500,
          fontFamily: 'monospace',
        }}
      >
        {conditionsSummary}
      </span>

      {/* Last triggered */}
      <span style={{ fontSize: 9.5, color: subTextColor, fontWeight: 500 }}>
        Last triggered: {formatTriggered(alert.lastTriggeredAt)}
      </span>

      {/* Action row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
        {confirmDelete ? (
          <>
            <span style={{ fontSize: 10, color: dangerColor, fontWeight: 600, flex: 1 }}>
              Delete this alert?
            </span>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: subTextColor,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                padding: '3px 8px',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onDelete(alert.id)}
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: '#FFFFFF',
                background: dangerColor,
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                fontFamily: 'inherit',
                padding: '3px 10px',
              }}
            >
              Delete
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onEdit(alert)}
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: accentColor,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                padding: '3px 8px',
              }}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: dangerColor,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                padding: '3px 8px',
              }}
            >
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}
