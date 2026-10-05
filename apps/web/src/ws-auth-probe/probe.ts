import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import './probe.css'
import { createMemoryStorage } from './memory-storage.ts'
import {
  createAttemptDeadline,
  exchangeWithinAttempt,
  type AttemptDeadline,
} from './lifecycle.ts'
import {
  consumeAuthCodeMessage,
  isCallbackReadyMessage,
  makeWebSocketUrl,
  marketEventType,
  type AuthCodeMessageState,
} from './protocol.ts'

const CALLBACK_URL = 'https://itswcl.github.io/fg-index/'
const CALLBACK_ORIGIN = new URL(CALLBACK_URL).origin
const EXPECTED_MARKET_EVENTS = new Set([
  'FEAR_GREED_UPDATE',
  'VIX_UPDATE',
  'BTC_UPDATE',
  'SPX_UPDATE',
])
const PROBE_ATTEMPT_TIMEOUT_MS = 5 * 60_000

function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function exchangeCodeForAccessToken(
  client: SupabaseClient,
  code: string,
): Promise<string | null> {
  try {
    const result = await client.auth.exchangeCodeForSession(code)
    if (result.error || !result.data.session?.access_token) return null
    return result.data.session.access_token
  } finally {
    await client.auth.dispose()
  }
}

function createProbeMarkup(root: HTMLElement): {
  status: HTMLParagraphElement
  events: HTMLParagraphElement
  signIn: HTMLButtonElement
  disconnect: HTMLButtonElement
} {
  const card = document.createElement('main')
  card.className = 'ws-auth-probe'

  const title = document.createElement('h1')
  title.textContent = 'Authenticated WebSocket check'

  const details = document.createElement('p')
  details.textContent =
    'This temporary page signs in with Supabase, opens one WebSocket, and shows market-data event names only. It makes no app HTTP requests and sends no WebSocket data messages.'

  const status = document.createElement('p')
  status.className = 'status'
  status.setAttribute('role', 'status')
  status.textContent = 'Not connected.'

  const events = document.createElement('p')
  events.className = 'events'
  events.textContent = 'Market-data events: none yet.'

  const signIn = document.createElement('button')
  signIn.type = 'button'
  signIn.textContent = 'Sign in with Google and connect once'

  const disconnect = document.createElement('button')
  disconnect.type = 'button'
  disconnect.className = 'secondary'
  disconnect.textContent = 'Disconnect'
  disconnect.disabled = true

  const note = document.createElement('p')
  note.textContent = 'A successful socket handshake alone does not confirm authentication; the operator verifies that separately.'

  card.append(title, details, status, events, signIn, disconnect, note)
  root.replaceChildren(card)
  return { status, events, signIn, disconnect }
}

export function startWebSocketProbe(): void {
  const root = document.getElementById('root')
  if (!root) return

  const ui = createProbeMarkup(root)
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? ''
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''
  if (!supabaseUrl || !anonKey) {
    ui.status.textContent = 'The sign-in check is not configured.'
    ui.signIn.disabled = true
    return
  }

  let attemptStarted = false
  let popup: Window | null = null
  let socket: WebSocket | null = null
  let storage: ReturnType<typeof createMemoryStorage> | null = null
  let client: SupabaseClient | null = null
  let messageHandler: ((event: MessageEvent<unknown>) => void) | null = null
  let timeout = 0
  let closePoll = 0
  let attemptDeadline: AttemptDeadline | null = null
  let popupClosedAt = 0
  let nonceSent = false
  let disposed = false

  const clearTransientState = (): void => {
    window.clearTimeout(timeout)
    window.clearInterval(closePoll)
    attemptDeadline?.clear()
    attemptDeadline = null
    if (messageHandler) window.removeEventListener('message', messageHandler)
    messageHandler = null
    const memoryStorage = storage
    memoryStorage?.clear()
    storage = null
    const authClient = client
    client = null
    if (authClient) void authClient.auth.dispose().catch(() => {})
    if (popup && !popup.closed) popup.close()
    popup = null
    const activeSocket = socket
    socket = null
    if (activeSocket) {
      activeSocket.onopen = null
      activeSocket.onmessage = null
      activeSocket.onerror = null
      activeSocket.onclose = null
      if (activeSocket.readyState < WebSocket.CLOSING) activeSocket.close()
    }
  }

  const finish = (message: string): void => {
    if (disposed) return
    disposed = true
    clearTransientState()
    ui.signIn.disabled = true
    ui.disconnect.disabled = true
    ui.status.textContent = message
  }

  const exchangeAndConnect = async (code: string): Promise<void> => {
    const memoryStorage = storage
    const authClient = client
    const deadline = attemptDeadline
    if (!memoryStorage || !authClient || !deadline) {
      return finish('The sign-in handoff could not be completed.')
    }

    try {
      const outcome = await exchangeWithinAttempt(
        () => exchangeCodeForAccessToken(authClient, code),
        deadline,
        (accessToken) => {
          deadline.clear()
          attemptDeadline = null
          let socketUrl = makeWebSocketUrl(accessToken)
          memoryStorage.clear()
          client = null
          storage = null
          const openedSocket = new WebSocket(socketUrl)
          socketUrl = ''
          socket = openedSocket
          ui.status.textContent = 'WebSocket connecting…'
          ui.disconnect.disabled = false

          const seen = new Set<string>()
          openedSocket.onopen = () => {
            ui.status.textContent = 'WebSocket open. Waiting for market-data events.'
          }
          openedSocket.onmessage = (event: MessageEvent<unknown>) => {
            const type = marketEventType(event.data)
            if (!type) return
            seen.add(type)
            ui.events.textContent = `Market-data events received (${seen.size}): ${[...seen].join(', ')}`
            if (seen.size === EXPECTED_MARKET_EVENTS.size) {
              finish('Initial market-data events received. The check has disconnected.')
            }
          }
          openedSocket.onerror = () => finish('The WebSocket check failed. No diagnostic details were retained.')
          openedSocket.onclose = () => finish('The WebSocket connection is closed.')
          timeout = window.setTimeout(
            () => finish('The short WebSocket check timed out and disconnected.'),
            30_000,
          )
        },
        () => memoryStorage.clear(),
      )
      code = ''
      if (outcome === 'expired' || disposed) return
      if (outcome === 'failed') {
        return finish('Sign-in could not be completed. No connection was opened.')
      }
    } catch {
      code = ''
      finish('Sign-in or the WebSocket check could not be completed.')
    }
  }

  const onProbeMessage = (event: MessageEvent<unknown>): void => {
    if (disposed || !popup) return

    if (isCallbackReadyMessage(event, CALLBACK_ORIGIN, popup)) {
      if (nonceSent) return
      nonceSent = true
      popup.postMessage({ type: 'ws-auth-probe-callback-nonce', nonce }, CALLBACK_ORIGIN)
      return
    }

    const code = consumeAuthCodeMessage(
      event,
      CALLBACK_ORIGIN,
      popup,
      nonce,
      messageState,
    )
    if (!code) return

    window.clearInterval(closePoll)
    if (messageHandler) window.removeEventListener('message', messageHandler)
    messageHandler = null
    closePoll = 0
    if (popup && !popup.closed) popup.close()
    popup = null
    ui.status.textContent = 'Completing sign-in…'
    void exchangeAndConnect(code)
  }

  let nonce = ''
  const messageState: AuthCodeMessageState = { consumed: false }

  ui.signIn.addEventListener('click', async () => {
    if (attemptStarted) return
    attemptStarted = true
    ui.signIn.disabled = true

    try {
      popup = window.open('about:blank', '_blank', 'popup,width=520,height=720')
      if (!popup) return finish('The browser blocked the sign-in window.')

      const attemptStorage = createMemoryStorage()
      storage = attemptStorage
      nonce = createNonce()
      messageHandler = onProbeMessage
      window.addEventListener('message', onProbeMessage)
      closePoll = window.setInterval(() => {
        if (popup?.closed && !socket) {
          popupClosedAt ||= Date.now()
          if (Date.now() - popupClosedAt > 3_000) {
            finish('The sign-in window was closed before completion.')
          }
        } else {
          popupClosedAt = 0
        }
      }, 500)
      attemptDeadline = createAttemptDeadline(
        () => finish('The sign-in check expired.'),
        {
          setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
          clearTimeout: (handle) => window.clearTimeout(handle),
        },
        PROBE_ATTEMPT_TIMEOUT_MS,
      )

      const authClient = createClient(supabaseUrl, anonKey, {
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
          flowType: 'pkce',
          persistSession: false,
          storage: attemptStorage,
          storageKey: `fg-index-ws-probe-${nonce}`,
        },
      })
      client = authClient
      const { data, error } = await authClient.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: CALLBACK_URL,
          skipBrowserRedirect: true,
        },
      })

      if (disposed) {
        attemptStorage.clear()
        await authClient.auth.dispose()
        return
      }

      if (error || !data.url || !popup || popup.closed) {
        return finish('Sign-in could not be started.')
      }

      popup.location.replace(data.url)
      popup.focus()
      ui.status.textContent = 'Complete sign-in in the separate window.'
    } catch {
      finish('Sign-in could not be started.')
    }
  })

  ui.disconnect.addEventListener('click', () => finish('The WebSocket check has disconnected.'))
  window.addEventListener('pagehide', () => {
    if (!disposed) {
      disposed = true
      clearTransientState()
    }
  }, { once: true })
}
