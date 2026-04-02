import { useState } from 'react';
import type { WebhookConfig, WebhookType } from '../../types/alerts';
import { API_BASE_URL, API_KEY } from '../../constants';

interface WebhookFormProps {
  webhook: WebhookConfig | null;
  onSave: (cfg: WebhookConfig) => void;
  onRemove: () => void;
  isDark: boolean;
}

const PLATFORMS: { type: WebhookType; label: string }[] = [
  { type: 'discord', label: 'Discord' },
  { type: 'slack', label: 'Slack' },
  { type: 'telegram', label: 'Telegram' },
];

function validateConfig(cfg: Partial<WebhookConfig> & { type: WebhookType }): string | null {
  if (cfg.type === 'discord' || cfg.type === 'slack') {
    if (!cfg.url?.startsWith('https://')) {
      return 'Webhook URL must start with https://';
    }
  } else if (cfg.type === 'telegram') {
    if (!cfg.botToken?.trim()) return 'Bot Token is required';
    if (!cfg.chatId?.trim()) return 'Chat ID is required';
  }
  return null;
}

export function WebhookForm({ webhook, onSave, onRemove, isDark }: WebhookFormProps) {
  const [selectedType, setSelectedType] = useState<WebhookType>(webhook?.type ?? 'discord');
  const [url, setUrl] = useState(webhook?.type !== 'telegram' ? (webhook?.url ?? '') : '');
  const [botToken, setBotToken] = useState(webhook?.botToken ?? '');
  const [chatId, setChatId] = useState(webhook?.chatId ?? '');
  const [error, setError] = useState<string | null>(null);

  type TestState = 'idle' | 'loading' | 'success' | 'error';
  const [testState, setTestState] = useState<TestState>('idle');
  const [testError, setTestError] = useState('');

  const borderColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.07)';
  const textColor = isDark ? '#FFFFFF' : '#000000';
  const subTextColor = '#8E8E93';
  const accentColor = '#007AFF';
  const inputBg = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.04)';
  const labelStyle = {
    fontSize: 10,
    fontWeight: 600,
    color: subTextColor,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.8,
    marginBottom: 4,
    display: 'block',
  };
  const inputStyle = {
    width: '100%',
    fontSize: 11,
    color: textColor,
    background: inputBg,
    border: `1px solid ${borderColor}`,
    borderRadius: 8,
    padding: '7px 10px',
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

  const buildCurrentConfig = (): WebhookConfig | null => {
    if (selectedType === 'discord' || selectedType === 'slack') {
      if (!url.trim()) return null;
      return { type: selectedType, url: url.trim() };
    }
    if (selectedType === 'telegram') {
      if (!botToken.trim() || !chatId.trim()) return null;
      return { type: 'telegram', botToken: botToken.trim(), chatId: chatId.trim() };
    }
    return null;
  };

  const handleTest = async () => {
    const config = buildCurrentConfig();
    if (!config) return;

    setTestState('loading');
    setTestError('');
    try {
      const res = await fetch(`${API_BASE_URL}/api/webhooks/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(API_KEY ? { 'X-API-KEY': API_KEY } : {}),
        },
        body: JSON.stringify({ webhook: config }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (data.ok) {
        setTestState('success');
        setTimeout(() => setTestState('idle'), 3000);
      } else {
        setTestState('error');
        setTestError(data.error ?? 'Unknown error');
        setTimeout(() => { setTestState('idle'); setTestError(''); }, 5000);
      }
    } catch {
      setTestState('error');
      setTestError('Could not reach server');
      setTimeout(() => { setTestState('idle'); setTestError(''); }, 5000);
    }
  };

  const handlePlatformChange = (type: WebhookType) => {
    setSelectedType(type);
    setError(null);
    // Reset fields when switching platform
    setUrl('');
    setBotToken('');
    setChatId('');
  };

  const handleSave = () => {
    const cfg: WebhookConfig =
      selectedType === 'telegram'
        ? { type: selectedType, botToken: botToken.trim(), chatId: chatId.trim() }
        : { type: selectedType, url: url.trim() };

    const validationError = validateConfig(cfg);
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    onSave(cfg);
  };

  const isConfigured = webhook !== null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Configured badge */}
      {isConfigured && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 10,
              fontWeight: 700,
              color: '#34C759',
              background: isDark ? 'rgba(52,199,89,0.12)' : 'rgba(52,199,89,0.1)',
              border: '1px solid rgba(52,199,89,0.3)',
              borderRadius: 6,
              padding: '3px 8px',
            }}
          >
            <span>✓</span> Configured ({webhook.type})
          </span>
        </div>
      )}

      {/* Platform selector */}
      <div>
        <span style={labelStyle}>Platform</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {PLATFORMS.map(({ type, label }) => {
            const active = selectedType === type;
            return (
              <button
                key={type}
                type="button"
                onClick={() => handlePlatformChange(type)}
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

      {/* Discord / Slack: URL only */}
      {(selectedType === 'discord' || selectedType === 'slack') && (
        <div>
          <label style={labelStyle}>Webhook URL</label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={
              selectedType === 'discord'
                ? 'https://discord.com/api/webhooks/…'
                : 'https://hooks.slack.com/services/…'
            }
            style={inputStyle}
          />
          <p style={helpStyle}>
            {selectedType === 'discord'
              ? 'ℹ  Server Settings → Integrations → Webhooks'
              : 'ℹ  api.slack.com → Your App → Incoming Webhooks'}
          </p>
        </div>
      )}

      {/* Telegram: bot token + chat ID */}
      {selectedType === 'telegram' && (
        <>
          <div>
            <label style={labelStyle}>Bot Token</label>
            <input
              type="text"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="123456789:ABC-DEF…"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Chat ID</label>
            <input
              type="text"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="-1001234567890"
              style={inputStyle}
            />
          </div>
          <p style={helpStyle}>
            ℹ  Get token from @BotFather, Chat ID from @userinfobot
          </p>
        </>
      )}

      {/* Validation error */}
      {error && (
        <p style={{ fontSize: 10, color: '#FF3B30', margin: 0 }}>{error}</p>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          onClick={handleSave}
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: '#FFFFFF',
            background: accentColor,
            border: 'none',
            borderRadius: 8,
            padding: '5px 14px',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Save
        </button>
        {buildCurrentConfig() && (
          <button
            type="button"
            onClick={handleTest}
            disabled={testState === 'loading'}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: accentColor,
              background: 'transparent',
              border: `1.5px solid ${accentColor}`,
              borderRadius: 8,
              padding: '4px 10px',
              cursor: testState === 'loading' ? 'default' : 'pointer',
              fontFamily: 'inherit',
              opacity: testState === 'loading' ? 0.6 : 1,
              transition: 'opacity 0.15s',
            }}
          >
            {testState === 'loading' ? 'Sending…' : 'Test'}
          </button>
        )}
        {isConfigured && (
          <button
            type="button"
            onClick={onRemove}
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: '#FF3B30',
              background: 'transparent',
              border: '1px solid rgba(255,59,48,0.4)',
              borderRadius: 8,
              padding: '5px 14px',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Remove
          </button>
        )}
      </div>

      {/* Test feedback */}
      {testState === 'success' && (
        <p style={{ fontSize: 11, color: '#34C759', margin: '6px 0 0' }}>
          ✅ Test message sent!
        </p>
      )}
      {testState === 'error' && (
        <p style={{ fontSize: 11, color: '#FF3B30', margin: '6px 0 0' }}>
          ❌ {testError}
        </p>
      )}
    </div>
  );
}
