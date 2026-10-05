import { resolveEntryRoute } from './ws-auth-probe/route'

const callback = window.__FG_INDEX_WS_AUTH_PROBE_CALLBACK__
const route = resolveEntryRoute({
  hasAuthCallbackContext: callback !== undefined,
  wantsProbe: new URLSearchParams(window.location.search).get('ws-auth-probe') === '1',
})

if (route === 'callback' && callback) {
  delete window.__FG_INDEX_WS_AUTH_PROBE_CALLBACK__
  void import('./ws-auth-probe/callback-relay')
    .then(({ relayPopupCallback }) => relayPopupCallback(callback))
    .catch(() => showSafeFailure())
} else if (route === 'probe') {
  window.history.replaceState(null, '', window.location.pathname)
  void import('./ws-auth-probe/probe')
    .then(({ startWebSocketProbe }) => startWebSocketProbe())
    .catch(() => showSafeFailure())
} else {
  void import('./app-main')
}

function showSafeFailure(): void {
  const root = document.getElementById('root')
  if (root) root.textContent = 'The isolated WebSocket check could not start.'
}
