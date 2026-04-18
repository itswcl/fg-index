import { useState } from 'react';
import { useWebhooks } from '../../hooks/useWebhooks';
import { MAX_WEBHOOKS } from '../../types/webhooks';
import type { CreateWebhookInput, Webhook, WebhookType } from '../../types/webhooks';
import { WebhookForm } from './WebhookForm';

interface WebhookListProps {
  isDark: boolean;
}

type View =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'edit'; webhook: Webhook };

const TYPE_LABEL: Record<WebhookType, string> = {
  discord: 'Discord',
  slack: 'Slack',
  telegram: 'Telegram',
  generic: 'Generic',
};

function describeTarget(w: Webhook): string {
  if (w.type === 'telegram') return w.chatId ? `Chat ${w.chatId}` : 'Telegram';
  if (!w.url) return TYPE_LABEL[w.type];
  try {
    const u = new URL(w.url);
    return u.host + (u.pathname.length > 1 ? u.pathname : '');
  } catch {
    return w.url;
  }
}

export function WebhookList({ isDark }: WebhookListProps) {
  const {
    webhooks,
    isLoading,
    createWebhook,
    updateWebhook,
    deleteWebhook,
    toggleWebhook,
    testWebhook,
  } = useWebhooks();

  const [view, setView] = useState<View>({ kind: 'list' });
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isFormSubmitting, setIsFormSubmitting] = useState(false);
  const [testState, setTestState] = useState<
    Record<string, { status: 'idle' | 'pending' | 'ok' | 'err'; error?: string }>
  >({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const borderColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
  const cardBg = isDark ? 'rgba(28,28,30,0.85)' : 'rgba(255,255,255,0.92)';
  const textColor = isDark ? '#FFFFFF' : '#000000';
  const subTextColor = '#8E8E93';
  const accentColor = '#007AFF';
  const dangerColor = '#E74C3C';
  const successColor = '#27AE60';

  const handleCreate = async (input: CreateWebhookInput) => {
    setIsFormSubmitting(true);
    setFormError(null);
    try {
      await createWebhook(input);
      setView({ kind: 'list' });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create webhook');
    } finally {
      setIsFormSubmitting(false);
    }
  };

  const handleEdit = async (id: string, input: CreateWebhookInput) => {
    setIsFormSubmitting(true);
    setFormError(null);
    try {
      await updateWebhook(id, input);
      setView({ kind: 'list' });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to update webhook');
    } finally {
      setIsFormSubmitting(false);
    }
  };

  const handleToggle = async (w: Webhook) => {
    setSubmittingId(w.id);
    try {
      await toggleWebhook(w.id, !w.enabled);
    } catch (err) {
      // useWebhooks onError rolls back the optimistic update; surface message.
      if (typeof window !== 'undefined') {
        window.alert(
          `Couldn't toggle webhook: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      setSubmittingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setSubmittingId(id);
    try {
      await deleteWebhook(id);
      setConfirmDeleteId(null);
    } catch (err) {
      if (typeof window !== 'undefined') {
        window.alert(
          `Couldn't delete webhook: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      setSubmittingId(null);
    }
  };

  const handleTest = async (id: string) => {
    setTestState((s) => ({ ...s, [id]: { status: 'pending' } }));
    try {
      const result = await testWebhook(id);
      setTestState((s) => ({
        ...s,
        [id]: result.ok
          ? { status: 'ok' }
          : { status: 'err', error: result.error ?? 'Test failed' },
      }));
      // Auto-clear the status chip after a few seconds so repeated tests feel clean.
      window.setTimeout(() => {
        setTestState((s) => {
          const copy = { ...s };
          delete copy[id];
          return copy;
        });
      }, 4000);
    } catch (err) {
      setTestState((s) => ({
        ...s,
        [id]: {
          status: 'err',
          error: err instanceof Error ? err.message : 'Test failed',
        },
      }));
    }
  };

  // ── Create view ────────────────────────────────────────────────────
  if (view.kind === 'create') {
    return (
      <WebhookForm
        onSubmit={handleCreate}
        onCancel={() => {
          setFormError(null);
          setView({ kind: 'list' });
        }}
        isDark={isDark}
        isSubmitting={isFormSubmitting}
        serverError={formError}
      />
    );
  }

  // ── Edit view ──────────────────────────────────────────────────────
  if (view.kind === 'edit') {
    return (
      <WebhookForm
        initial={view.webhook}
        onSubmit={(input) => handleEdit(view.webhook.id, input)}
        onCancel={() => {
          setFormError(null);
          setView({ kind: 'list' });
        }}
        isDark={isDark}
        isSubmitting={isFormSubmitting}
        serverError={formError}
      />
    );
  }

  // ── List view ──────────────────────────────────────────────────────
  const atCap = webhooks.length >= MAX_WEBHOOKS;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {isLoading && (
        <p style={{ fontSize: 11, color: subTextColor, textAlign: 'center', padding: '6px 0' }}>
          Loading webhooks…
        </p>
      )}

      {!isLoading && webhooks.length === 0 && (
        <p
          style={{
            fontSize: 11,
            color: subTextColor,
            textAlign: 'center',
            padding: '8px 0 4px',
            lineHeight: 1.5,
            margin: 0,
          }}
        >
          No webhooks yet. Add one to receive alert notifications.
        </p>
      )}

      {webhooks.map((w) => {
        const test = testState[w.id];
        const isConfirmingDelete = confirmDeleteId === w.id;
        const isSubmitting = submittingId === w.id;

        return (
          <div
            key={w.id}
            style={{
              background: cardBg,
              border: `1.5px solid ${borderColor}`,
              borderRadius: 14,
              padding: '10px 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              opacity: w.enabled ? 1 : 0.55,
              transition: 'opacity 0.2s ease',
              boxShadow: isDark
                ? '0 2px 8px rgba(0,0,0,0.3)'
                : '0 2px 6px rgba(0,0,0,0.07)',
            }}
          >
            {/* Top row: name + type badge + toggle */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                title={w.name}
              >
                {w.name}
              </span>
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  color: subTextColor,
                  textTransform: 'uppercase',
                  letterSpacing: 0.8,
                  background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
                  borderRadius: 6,
                  padding: '2px 6px',
                  flexShrink: 0,
                }}
              >
                {TYPE_LABEL[w.type]}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={w.enabled}
                onClick={() => void handleToggle(w)}
                disabled={isSubmitting}
                aria-label={w.enabled ? 'Disable webhook' : 'Enable webhook'}
                style={{
                  width: 36,
                  height: 20,
                  borderRadius: 10,
                  border: 'none',
                  cursor: isSubmitting ? 'not-allowed' : 'pointer',
                  background: w.enabled ? accentColor : isDark ? '#3A3A3C' : '#D1D1D6',
                  position: 'relative',
                  transition: 'background 0.2s ease',
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: 2,
                    left: w.enabled ? 18 : 2,
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

            {/* Target summary */}
            <span
              style={{
                fontSize: 11,
                color: subTextColor,
                fontWeight: 500,
                fontFamily: 'monospace',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={describeTarget(w)}
            >
              {describeTarget(w)}
            </span>

            {/* Test status chip */}
            {test && test.status !== 'idle' && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color:
                    test.status === 'ok'
                      ? successColor
                      : test.status === 'err'
                        ? dangerColor
                        : subTextColor,
                }}
              >
                {test.status === 'pending' && 'Sending test…'}
                {test.status === 'ok' && 'Test delivered ✓'}
                {test.status === 'err' && `Test failed: ${test.error}`}
              </span>
            )}

            {/* Action row */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                justifyContent: 'flex-end',
              }}
            >
              {isConfirmingDelete ? (
                <>
                  <span style={{ fontSize: 10, color: dangerColor, fontWeight: 600, flex: 1 }}>
                    Delete this webhook?
                  </span>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(null)}
                    disabled={isSubmitting}
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: subTextColor,
                      background: 'transparent',
                      border: 'none',
                      cursor: isSubmitting ? 'not-allowed' : 'pointer',
                      fontFamily: 'inherit',
                      padding: '3px 8px',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(w.id)}
                    disabled={isSubmitting}
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: '#FFFFFF',
                      background: dangerColor,
                      border: 'none',
                      borderRadius: 6,
                      cursor: isSubmitting ? 'not-allowed' : 'pointer',
                      fontFamily: 'inherit',
                      padding: '3px 10px',
                      opacity: isSubmitting ? 0.6 : 1,
                    }}
                  >
                    Delete
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void handleTest(w.id)}
                    disabled={!w.enabled || test?.status === 'pending'}
                    title={w.enabled ? 'Send a test notification' : 'Enable the webhook to test'}
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: w.enabled ? accentColor : subTextColor,
                      background: 'transparent',
                      border: 'none',
                      cursor:
                        !w.enabled || test?.status === 'pending' ? 'not-allowed' : 'pointer',
                      fontFamily: 'inherit',
                      padding: '3px 8px',
                    }}
                  >
                    Test
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setFormError(null);
                      setView({ kind: 'edit', webhook: w });
                    }}
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
                    onClick={() => setConfirmDeleteId(w.id)}
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
      })}

      {/* Add-webhook CTA */}
      <button
        type="button"
        onClick={() => {
          setFormError(null);
          setView({ kind: 'create' });
        }}
        disabled={atCap}
        title={atCap ? `You've reached the ${MAX_WEBHOOKS}-webhook limit` : 'Add a webhook'}
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: atCap ? subTextColor : accentColor,
          background: 'transparent',
          border: `1px dashed ${atCap ? borderColor : accentColor}`,
          borderRadius: 10,
          padding: '8px 10px',
          cursor: atCap ? 'not-allowed' : 'pointer',
          fontFamily: 'inherit',
          transition: 'opacity 0.15s',
          marginTop: 2,
        }}
      >
        {atCap
          ? `Max ${MAX_WEBHOOKS} webhooks reached`
          : `+ Add webhook${webhooks.length > 0 ? ` (${webhooks.length}/${MAX_WEBHOOKS})` : ''}`}
      </button>
    </div>
  );
}
