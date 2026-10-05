import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

import {
  consumeAuthCodeMessage,
  isCallbackReadyMessage,
  isValidAuthCode,
  makeAuthCodeMessage,
  makeWebSocketUrl,
  marketEventType,
  readCallbackNonce,
} from '../src/ws-auth-probe/protocol.ts'
import { relayPopupCallback } from '../src/ws-auth-probe/callback-relay.ts'
import { createMemoryStorage } from '../src/ws-auth-probe/memory-storage.ts'
import { resolveEntryRoute } from '../src/ws-auth-probe/route.ts'
import { createAttemptDeadline, exchangeWithinAttempt } from '../src/ws-auth-probe/lifecycle.ts'

const webRoot = new URL('../', import.meta.url)
const read = (relativePath) => readFileSync(new URL(relativePath, webRoot), 'utf8')

function callbackScrubScript() {
  const html = read('index.html')
  const match = html.match(/<script id="ws-probe-callback-scrub">([\s\S]*?)<\/script>/)
  assert.ok(match, 'callback scrub script exists')
  assert.ok(html.indexOf(match[0]) < html.indexOf('<link'), 'callback scrub runs before linked resources')
  assert.ok(html.indexOf(match[0]) < html.indexOf('<script type="module"'), 'callback scrub runs before the app module')
  return match[1]
}

function runCallbackScrub(search, opener = {}) {
  let replacement
  const window = {
    opener,
    location: { search, pathname: '/fg-index/' },
    history: { replaceState: (...args) => { replacement = args } },
  }
  runInNewContext(callbackScrubScript(), { window, URLSearchParams })
  return { window, replacement }
}

test('callback query is copied only in the popup, then removed before linked resources load', () => {
  const result = runCallbackScrub('?code=one-time%2Bcode&state=opaque')
  assert.equal(result.window.__FG_INDEX_WS_AUTH_PROBE_CALLBACK__.code, 'one-time+code')
  assert.equal(result.window.__FG_INDEX_WS_AUTH_PROBE_CALLBACK__.failed, false)
  assert.deepEqual(result.replacement, [null, '', '/fg-index/'])
})

test('provider errors are reduced to a boolean and their query is removed', () => {
  const result = runCallbackScrub('?error=access_denied&error_description=private%20detail')
  assert.equal(result.window.__FG_INDEX_WS_AUTH_PROBE_CALLBACK__.code, null)
  assert.equal(result.window.__FG_INDEX_WS_AUTH_PROBE_CALLBACK__.failed, true)
  assert.deepEqual(result.replacement, [null, '', '/fg-index/'])
})

test('empty or duplicate callback code parameters fail closed', () => {
  for (const search of ['?code=', '?code=first&code=second']) {
    const result = runCallbackScrub(search)
    assert.equal(result.window.__FG_INDEX_WS_AUTH_PROBE_CALLBACK__.code, null)
    assert.equal(result.window.__FG_INDEX_WS_AUTH_PROBE_CALLBACK__.failed, true)
    assert.deepEqual(result.replacement, [null, '', '/fg-index/'])
  }
})

test('a callback code without its opener fails closed instead of loading app hooks', () => {
  const result = runCallbackScrub('?code=orphaned-probe-code', null)
  assert.equal(result.window.__FG_INDEX_WS_AUTH_PROBE_CALLBACK__.code, 'orphaned-probe-code')
  assert.equal(result.window.__FG_INDEX_WS_AUTH_PROBE_CALLBACK__.failed, false)
  assert.deepEqual(result.replacement, [null, '', '/fg-index/'])
})

test('existing implicit OAuth callbacks remain on the normal app route', () => {
  const result = runCallbackScrub('')
  assert.equal(result.window.__FG_INDEX_WS_AUTH_PROBE_CALLBACK__, undefined)
  assert.equal(result.replacement, undefined)
})

test('entry routing isolates callback and probe before the normal app route', () => {
  assert.equal(resolveEntryRoute({ hasAuthCallbackContext: true, wantsProbe: true }), 'callback')
  assert.equal(resolveEntryRoute({ hasAuthCallbackContext: false, wantsProbe: true }), 'probe')
  assert.equal(resolveEntryRoute({ hasAuthCallbackContext: false, wantsProbe: false }), 'app')
})

test('main bootstrap has no static app, hook, React, or Supabase imports', () => {
  const main = read('src/main.tsx')
  const staticImports = [...main.matchAll(/^\s*import\s+.*?from\s+['"]([^'"]+)['"]/gm)]
    .map((match) => match[1])
  assert.deepEqual(staticImports, ['./ws-auth-probe/route'])
  assert.match(main, /import\('\.\/app-main'\)/)
})

test('probe modules have no app HTTP, app auth helper, browser persistence, logging, or data-send path', () => {
  const probe = read('src/ws-auth-probe/probe.ts')
  const relay = read('src/ws-auth-probe/callback-relay.ts')
  const combined = `${probe}\n${relay}`
  assert.doesNotMatch(combined, /authFetch|localStorage|sessionStorage|\bfetch\s*\(/)
  assert.doesNotMatch(combined, /console\.(?:log|info|warn|error)\s*\(/)
  assert.doesNotMatch(combined, /\b(?:socket|openedSocket)\.send\s*\(/)
  assert.match(probe, /new WebSocket\(socketUrl\)/)
})

test('callback readiness requires the exact origin, popup, and message shape', () => {
  const opener = {}
  const popup = {}
  const ready = { origin: 'https://itswcl.github.io', source: popup, data: { type: 'ws-auth-probe-callback-ready' } }
  assert.equal(isCallbackReadyMessage(ready, 'https://itswcl.github.io', popup), true)
  assert.equal(isCallbackReadyMessage({ ...ready, origin: 'https://attacker.example' }, 'https://itswcl.github.io', popup), false)
  assert.equal(isCallbackReadyMessage({ ...ready, source: opener }, 'https://itswcl.github.io', popup), false)
  assert.equal(isCallbackReadyMessage({ ...ready, data: { ...ready.data, nonce: 'unexpected' } }, 'https://itswcl.github.io', popup), false)
})

test('callback nonce is accepted only from the exact same-origin opener', () => {
  const opener = {}
  const nonce = 'a'.repeat(64)
  const event = {
    origin: 'https://itswcl.github.io',
    source: opener,
    data: { type: 'ws-auth-probe-callback-nonce', nonce },
  }
  assert.equal(readCallbackNonce(event, event.origin, opener), nonce)
  assert.equal(readCallbackNonce({ ...event, source: {} }, event.origin, opener), null)
  assert.equal(readCallbackNonce({ ...event, origin: 'https://attacker.example' }, event.origin, opener), null)
})

test('popup relay emits the one-time code only after opener nonce handshake', () => {
  const opener = { messages: [], postMessage(message, targetOrigin) { this.messages.push({ message, targetOrigin }) } }
  const listeners = new Map()
  let closeCount = 0
  let timerHandler
  const fakeWindow = {
    opener,
    location: { origin: 'https://itswcl.github.io' },
    setTimeout(handler) { timerHandler = handler; return 1 },
    clearTimeout() {},
    addEventListener(type, handler) { listeners.set(type, handler) },
    removeEventListener(type) { listeners.delete(type) },
    close() { closeCount += 1 },
  }
  const root = { textContent: '' }
  const priorWindow = globalThis.window
  const priorDocument = globalThis.document
  globalThis.window = fakeWindow
  globalThis.document = { getElementById: () => root }

  try {
    relayPopupCallback({ code: 'short-lived-code', failed: false })
    assert.deepEqual(opener.messages, [{
      message: { type: 'ws-auth-probe-callback-ready' },
      targetOrigin: 'https://itswcl.github.io',
    }])

    listeners.get('message')({
      origin: 'https://itswcl.github.io',
      source: opener,
      data: { type: 'ws-auth-probe-callback-nonce', nonce: 'c'.repeat(64) },
    })

    assert.deepEqual(opener.messages[1], {
      message: {
        type: 'ws-auth-probe-code',
        code: 'short-lived-code',
        nonce: 'c'.repeat(64),
      },
      targetOrigin: 'https://itswcl.github.io',
    })
    assert.equal(closeCount, 1)
    assert.equal(listeners.has('message'), false)
    assert.equal(typeof timerHandler, 'function')
  } finally {
    if (priorWindow === undefined) delete globalThis.window
    else globalThis.window = priorWindow
    if (priorDocument === undefined) delete globalThis.document
    else globalThis.document = priorDocument
  }
})

test('popup provider failure never relays provider details or a code', () => {
  const opener = { messages: [], postMessage(message) { this.messages.push(message) } }
  let closeCount = 0
  const priorWindow = globalThis.window
  const priorDocument = globalThis.document
  globalThis.window = { opener, close() { closeCount += 1 } }
  globalThis.document = { getElementById: () => ({ textContent: '' }) }
  try {
    relayPopupCallback({ code: null, failed: true })
    assert.deepEqual(opener.messages, [])
    assert.equal(closeCount, 1)
  } finally {
    if (priorWindow === undefined) delete globalThis.window
    else globalThis.window = priorWindow
    if (priorDocument === undefined) delete globalThis.document
    else globalThis.document = priorDocument
  }
})

test('callback with no opener fails closed without starting the normal app', () => {
  let closeCount = 0
  const root = { textContent: '' }
  const priorWindow = globalThis.window
  const priorDocument = globalThis.document
  globalThis.window = { opener: null, close() { closeCount += 1 } }
  globalThis.document = { getElementById: () => root }
  try {
    relayPopupCallback({ code: 'orphaned-code', failed: false })
    assert.equal(root.textContent, 'Sign-in did not complete. You can close this window.')
    assert.equal(closeCount, 1)
  } finally {
    if (priorWindow === undefined) delete globalThis.window
    else globalThis.window = priorWindow
    if (priorDocument === undefined) delete globalThis.document
    else globalThis.document = priorDocument
  }
})

test('auth code handoff is exact-shape, source/origin/nonce bound, and one use', () => {
  const popup = {}
  const nonce = 'b'.repeat(64)
  const state = { consumed: false }
  const event = {
    origin: 'https://itswcl.github.io',
    source: popup,
    data: makeAuthCodeMessage('one-time-code', nonce),
  }

  assert.equal(consumeAuthCodeMessage(event, event.origin, popup, nonce, state), 'one-time-code')
  assert.equal(state.consumed, true)
  assert.equal(consumeAuthCodeMessage(event, event.origin, popup, nonce, state), null)
  assert.equal(consumeAuthCodeMessage({ ...event, source: {} }, event.origin, popup, nonce, { consumed: false }), null)
  assert.equal(consumeAuthCodeMessage({ ...event, data: { ...event.data, nonce: 'wrong' } }, event.origin, popup, nonce, { consumed: false }), null)
  assert.equal(consumeAuthCodeMessage({ ...event, data: { ...event.data, access_token: 'unexpected' } }, event.origin, popup, nonce, { consumed: false }), null)
})

test('auth code validation bounds and rejects control characters', () => {
  assert.equal(isValidAuthCode('one-time-code'), true)
  assert.equal(isValidAuthCode(''), false)
  assert.equal(isValidAuthCode('bad\ncode'), false)
  assert.equal(isValidAuthCode('x'.repeat(4097)), false)
})

test('market stream parser returns only expected event names and never payloads', () => {
  assert.equal(marketEventType('{"type":"BTC_UPDATE","payload":{"price":1}}'), 'BTC_UPDATE')
  assert.equal(marketEventType('{"type":"alert_triggered","payload":{"message":"private"}}'), null)
  assert.equal(marketEventType('{not-json'), null)
  assert.equal(marketEventType(new Blob()), null)
})

test('WebSocket URL targets OCI and encodes the token as a query value', () => {
  const url = new URL(makeWebSocketUrl('dummy.jwt.token'))
  assert.equal(url.origin, 'wss://fg-index-api.duckdns.org')
  assert.equal(url.pathname, '/')
  assert.equal(url.searchParams.get('token'), 'dummy.jwt.token')
  assert.equal([...url.searchParams.keys()].join(','), 'token')
})

test('PKCE storage is memory-only and can be cleared after the exchange', () => {
  const storage = createMemoryStorage()
  storage.setItem('code-verifier', 'temporary-test-value')
  assert.equal(storage.getItem('code-verifier'), 'temporary-test-value')
  storage.clear()
  assert.equal(storage.getItem('code-verifier'), null)
})

test('a stalled code exchange cannot revive an expired attempt or open its socket', async () => {
  let expire
  let acceptCount = 0
  let transientClearCount = 0
  let resolveExchange
  const deadline = createAttemptDeadline(
    () => { transientClearCount += 1 },
    {
      setTimeout(callback, delayMs) {
        assert.equal(delayMs, 5 * 60_000)
        expire = callback
        return 7
      },
      clearTimeout() {},
    },
    5 * 60_000,
  )
  const pending = exchangeWithinAttempt(
    () => new Promise((resolve) => { resolveExchange = resolve }),
    deadline,
    () => { acceptCount += 1 },
    () => { transientClearCount += 1 },
  )

  expire()
  assert.equal(deadline.isActive(), false)
  assert.equal(transientClearCount, 1)
  resolveExchange('late-access-token')

  assert.equal(await pending, 'expired')
  assert.equal(acceptCount, 0)
  assert.equal(transientClearCount, 2)
})

test('a code exchange accepted before the deadline clears temporary state', async () => {
  let timerCleared = 0
  let acceptedValue = null
  let transientClearCount = 0
  const deadline = createAttemptDeadline(
    () => assert.fail('deadline should not expire'),
    {
      setTimeout: () => 9,
      clearTimeout: (handle) => { timerCleared = handle },
    },
    5 * 60_000,
  )

  assert.equal(
    await exchangeWithinAttempt(
      async () => 'short-lived-access-token',
      deadline,
      (value) => { acceptedValue = value },
      () => { transientClearCount += 1 },
    ),
    'accepted',
  )
  assert.equal(acceptedValue, 'short-lived-access-token')
  assert.equal(timerCleared, 9)
  assert.equal(deadline.isActive(), false)
  assert.equal(transientClearCount, 1)
})
