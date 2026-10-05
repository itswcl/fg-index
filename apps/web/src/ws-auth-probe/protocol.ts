export interface ProbeMessageEvent {
  origin: string
  source: object | null
  data: unknown
}

export interface AuthCodeMessageState {
  consumed: boolean
}

const MARKET_EVENT_TYPES = new Set([
  'FEAR_GREED_UPDATE',
  'VIX_UPDATE',
  'BTC_UPDATE',
  'SPX_UPDATE',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

export function isValidAuthCode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

export function isCallbackReadyMessage(
  event: ProbeMessageEvent,
  expectedOrigin: string,
  expectedPopup: object,
): boolean {
  return (
    event.origin === expectedOrigin &&
    event.source === expectedPopup &&
    isRecord(event.data) &&
    hasExactKeys(event.data, ['type']) &&
    event.data.type === 'ws-auth-probe-callback-ready'
  )
}

export function readCallbackNonce(
  event: ProbeMessageEvent,
  expectedOrigin: string,
  expectedOpener: object,
): string | null {
  if (
    event.origin !== expectedOrigin ||
    event.source !== expectedOpener ||
    !isRecord(event.data) ||
    !hasExactKeys(event.data, ['type', 'nonce']) ||
    event.data.type !== 'ws-auth-probe-callback-nonce' ||
    typeof event.data.nonce !== 'string' ||
    !/^[a-f0-9]{64}$/.test(event.data.nonce)
  ) {
    return null
  }
  return event.data.nonce
}

export function makeAuthCodeMessage(code: string, nonce: string): {
  type: 'ws-auth-probe-code'
  code: string
  nonce: string
} {
  return { type: 'ws-auth-probe-code', code, nonce }
}

export function consumeAuthCodeMessage(
  event: ProbeMessageEvent,
  expectedOrigin: string,
  expectedPopup: object,
  expectedNonce: string,
  state: AuthCodeMessageState,
): string | null {
  if (
    state.consumed ||
    event.origin !== expectedOrigin ||
    event.source !== expectedPopup ||
    !isRecord(event.data) ||
    !hasExactKeys(event.data, ['type', 'code', 'nonce']) ||
    event.data.type !== 'ws-auth-probe-code' ||
    event.data.nonce !== expectedNonce ||
    !isValidAuthCode(event.data.code)
  ) {
    return null
  }

  state.consumed = true
  return event.data.code
}

export function marketEventType(message: unknown): string | null {
  if (typeof message !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(message)
    if (!isRecord(parsed) || typeof parsed.type !== 'string') return null
    return MARKET_EVENT_TYPES.has(parsed.type) ? parsed.type : null
  } catch {
    return null
  }
}

export function makeWebSocketUrl(accessToken: string): string {
  const url = new URL('wss://fg-index-api.duckdns.org/')
  url.searchParams.set('token', accessToken)
  return url.toString()
}
