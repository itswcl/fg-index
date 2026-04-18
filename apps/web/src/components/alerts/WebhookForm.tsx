import { useState } from 'react';
import { FORM_TOKENS } from './formTokens';
import type {
  CreateWebhookInput,
  Webhook,
  WebhookType,
} from '../../types/webhooks';

interface WebhookFormProps {
  /** When provided, the form operates in edit mode with these fields prefilled. */
  initial?: Webhook;
  onSubmit: (input: CreateWebhookInput) => void | Promise<void>;
  onCancel: () => void;
  isDark: boolean;
  /** Disable the submit button while the parent's mutation is running. */
  isSubmitting?: boolean;
  /** If set, renders a top-level error banner (e.g. from a server 400/409). */
  serverError?: string | null;
}

const PLATFORMS: { type: WebhookType; label: string }[] = [
  { type: 'discord', label: 'Discord' },
  { type: 'slack', label: 'Slack' },
  { type: 'telegram', label: 'Telegram' },
  { type: 'generic', label: 'Generic' },
];

function validate(input: CreateWebhookInput): string | null {
  if (!input.name.trim()) return 'Name is required';
  if (input.type === 'telegram') {
    if (!input.botToken?.trim()) return 'Bot Token is required';
    if (!input.chatId?.trim()) return 'Chat ID is required';
  } else {
    if (!input.url?.trim()) return 'Webhook URL is required';
    if (!/^https?:\/\//i.test(input.url)) {
      return 'Webhook URL must start with http(s)://';
    }
  }
  return null;
}

function placeholderFor(type: WebhookType): string {
  switch (type) {
    case 'discord':
      return 'https://discord.com/api/webhooks/…';
    case 'slack':
      return 'https://hooks.slack.com/services/…';
    case 'generic':
      return 'https://example.com/hooks/fg-index';
    default:
      return '';
  }
}

function hintFor(type: WebhookType): string {
  switch (type) {
    case 'discord':
      return 'ℹ  Server Settings → Integrations → Webhooks';
    case 'slack':
      return 'ℹ  api.slack.com → Your App → Incoming Webhooks';
    case 'telegram':
      return 'ℹ  Get token from @BotFather, Chat ID from @userinfobot. Group chat IDs start with -100.';
    case 'generic':
      return 'ℹ  Any HTTPS endpoint that accepts JSON `{ alertName, message }`.';
  }
}

export function WebhookForm({
  initial,
  onSubmit,
  onCancel,
  isDark,
  isSubmitting = false,
  serverError = null,
}: WebhookFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState<WebhookType>(initial?.type ?? 'discord');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [botToken, setBotToken] = useState(initial?.botToken ?? '');
  const [chatId, setChatId] = useState(initial?.chatId ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [localError, setLocalError] = useState<string | null>(null);

  const borderColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.07)';
  const textColor = isDark ? '#FFFFFF' : '#000000';
  const subTextColor = '#8E8E93';
  const accentColor = '#007AFF';
  const dangerColor = '#FF3B30';
  const inputBg = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.04)';
  const labelStyle = {
    fontSize: FORM_TOKENS.labelFontSize,
    fontWeight: FORM_TOKENS.labelFontWeight,
    color: subTextColor,
    textTransform: 'uppercase' as const,
    letterSpacing: FORM_TOKENS.labelLetterSpacing,
    marginBottom: 4,
    display: 'block',
  };
  const inputStyle = {
    width: '100%',
    fontSize: FORM_TOKENS.inputFontSize,
    color: textColor,
    background: inputBg,
    border: `1px solid ${borderColor}`,
    borderRadius: FORM_TOKENS.inputBorderRadius,
    padding: FORM_TOKENS.inputPadding,
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box' as const,
  };
  const helpStyle = {
    fontSize: 10,
    color: subTextColor,
    lineHeight: 1.5,
    marginTop: 5,
  };

  const handleTypeChange = (next: WebhookType) => {
    setType(next);
    setLocalError(null);
    // Reset the type-specific fields to avoid submitting leftover values.
    if (next === 'telegram') {
      setUrl('');
    } else {
      setBotToken('');
      setChatId('');
    }
  };

  const buildInput = (): CreateWebhookInput => {
    if (type === 'telegram') {
      return {
        name: name.trim(),
        type,
        botToken: botToken.trim(),
        chatId: chatId.trim(),
        enabled,
      };
    }
    return {
      name: name.trim(),
      type,
      url: url.trim(),
      enabled,
    };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const input = buildInput();
    const err = validate(input);
    if (err) {
      setLocalError(err);
      return;
    }
    setLocalError(null);
    await onSubmit(input);
  };

  const isEdit = !!initial;
  const combinedError = localError ?? serverError;

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Name */}
      <div>
        <label style={labelStyle} htmlFor="webhook-name">
          Name
        </label>
        <input
          id="webhook-name"
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (localError) setLocalError(null);
          }}
          placeholder="e.g. My Discord server"
          style={inputStyle}
          maxLength={60}
        />
      </div>

      {/* Platform selector */}
      <div>
        <span style={labelStyle}>Platform</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {PLATFORMS.map(({ type: t, label }) => {
            const active = type === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => handleTypeChange(t)}
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: active ? '#FFFFFF' : subTextColor,
                  background: active ? accentColor : inputBg,
                  border: `1px solid ${active ? accentColor : borderColor}`,
                  borderRadius: 8,
                  padding: '5px 10px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  transition: 'all 0.15s',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* URL for discord/slack/generic */}
      {type !== 'telegram' && (
        <div>
          <label style={labelStyle} htmlFor="webhook-url">
            Webhook URL
          </label>
          <input
            id="webhook-url"
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (localError) setLocalError(null);
            }}
            placeholder={placeholderFor(type)}
            style={inputStyle}
          />
          <p style={helpStyle}>{hintFor(type)}</p>
        </div>
      )}

      {/* Telegram fields */}
      {type === 'telegram' && (
        <>
          <div>
            <label style={labelStyle} htmlFor="webhook-bot-token">
              Bot Token
            </label>
            <input
              id="webhook-bot-token"
              type="text"
              value={botToken}
              onChange={(e) => {
                setBotToken(e.target.value);
                if (localError) setLocalError(null);
              }}
              placeholder="123456789:ABC-DEF…"
              style={inputStyle}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div>
            <label style={labelStyle} htmlFor="webhook-chat-id">
              Chat ID
            </label>
            <input
              id="webhook-chat-id"
              type="text"
              value={chatId}
              onChange={(e) => {
                setChatId(e.target.value);
                if (localError) setLocalError(null);
              }}
              placeholder="-1001234567890"
              style={inputStyle}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <p style={helpStyle}>{hintFor('telegram')}</p>
        </>
      )}

      {/* Enabled checkbox */}
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          color: textColor,
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          style={{ accentColor, width: 14, height: 14 }}
        />
        Enabled — send alerts to this webhook
      </label>

      {/* Error banner */}
      {combinedError && (
        <p style={{ fontSize: 11, color: dangerColor, margin: 0 }}>{combinedError}</p>
      )}

      {/* Actions */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          justifyContent: 'flex-end',
        }}
      >
        <button
          type="button"
          onClick={onCancel}
          disabled={isSubmitting}
          style={{
            fontSize: FORM_TOKENS.actionBtnFontSize,
            fontWeight: 600,
            color: subTextColor,
            background: 'transparent',
            border: `1px solid ${borderColor}`,
            borderRadius: FORM_TOKENS.actionBtnBorderRadius,
            padding: FORM_TOKENS.actionBtnPaddingSecondary,
            cursor: isSubmitting ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            opacity: isSubmitting ? 0.5 : 1,
          }}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isSubmitting}
          style={{
            fontSize: FORM_TOKENS.actionBtnFontSize,
            fontWeight: 700,
            color: '#FFFFFF',
            background: accentColor,
            border: 'none',
            borderRadius: FORM_TOKENS.actionBtnBorderRadius,
            padding: FORM_TOKENS.actionBtnPaddingPrimary,
            cursor: isSubmitting ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            opacity: isSubmitting ? 0.5 : 1,
            transition: 'opacity 0.15s',
          }}
        >
          {isSubmitting ? 'Saving…' : isEdit ? 'Save' : 'Add webhook'}
        </button>
      </div>
    </form>
  );
}
