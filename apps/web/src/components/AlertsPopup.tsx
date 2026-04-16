import { useEffect, useRef } from 'react';
import { AlertsPanel } from './alerts';
import type { Alert } from '../types/alerts';
import { useAuth } from '../hooks/useAuth';

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
  isAnonymous: boolean;
  migrationCandidate: Alert[] | null;
  onAcceptMigration: () => void;
  onDismissMigration: () => void;
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
  isAnonymous,
  migrationCandidate,
  onAcceptMigration,
  onDismissMigration,
}: AlertsPopupProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { signIn } = useAuth();

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const accent = '#007AFF';

  return (
    <div
      ref={ref}
      className={`alerts-popup ${isDark ? 'alerts-popup-dark' : 'alerts-popup-light'}`}
      style={{ position: 'relative' }}
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

      {/* ── Sign-in gate overlay (anonymous users) ───────────────── */}
      {isAnonymous && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 'inherit',
            background: isDark ? 'rgba(18,18,20,0.85)' : 'rgba(242,242,247,0.85)',
            backdropFilter: 'blur(6px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            padding: 20,
            textAlign: 'center',
            zIndex: 2,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: isDark ? '#FFF' : '#000' }}>
            Sign in to use alerts
          </div>
          <div style={{ fontSize: 11, color: '#8E8E93', lineHeight: 1.5, maxWidth: 260 }}>
            Your alerts and webhook sync across devices once you sign in.
          </div>
          <button
            type="button"
            onClick={() => { void signIn(); }}
            style={{
              marginTop: 4,
              fontSize: 12,
              fontWeight: 700,
              color: '#FFFFFF',
              background: accent,
              border: 'none',
              borderRadius: 8,
              padding: '8px 14px',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Sign in with Google
          </button>
        </div>
      )}

      {/* ── Migration modal (first-time import prompt) ───────────── */}
      {migrationCandidate && migrationCandidate.length > 0 && !isAnonymous && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 'inherit',
            background: isDark ? 'rgba(18,18,20,0.9)' : 'rgba(242,242,247,0.9)',
            backdropFilter: 'blur(6px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            padding: 20,
            textAlign: 'center',
            zIndex: 3,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: isDark ? '#FFF' : '#000' }}>
            Import {migrationCandidate.length} saved alert
            {migrationCandidate.length === 1 ? '' : 's'}?
          </div>
          <div style={{ fontSize: 11, color: '#8E8E93', lineHeight: 1.5, maxWidth: 280 }}>
            We found alerts saved on this device from before you signed in.
            Import them to your account so they sync across devices.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button
              type="button"
              onClick={onDismissMigration}
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: isDark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.7)',
                background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
                border: 'none',
                borderRadius: 8,
                padding: '8px 14px',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Discard
            </button>
            <button
              type="button"
              onClick={onAcceptMigration}
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: '#FFFFFF',
                background: accent,
                border: 'none',
                borderRadius: 8,
                padding: '8px 14px',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Import
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
