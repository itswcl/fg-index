import { isValidAuthCode, readCallbackNonce } from './protocol.ts'

interface PopupCallback {
  code: string | null
  failed: boolean
}

export function relayPopupCallback(callback: PopupCallback): void {
  const root = document.getElementById('root')
  const opener = window.opener
  const code = callback.code

  if (!root || !opener || callback.failed || !isValidAuthCode(code)) {
    if (root) root.textContent = 'Sign-in did not complete. You can close this window.'
    window.close()
    return
  }

  root.textContent = 'Returning to the WebSocket check…'
  let complete = false
  const finish = (): void => {
    if (complete) return
    complete = true
    window.clearTimeout(timeout)
    window.removeEventListener('message', onMessage)
    window.close()
  }

  const onMessage = (event: MessageEvent<unknown>): void => {
    const nonce = readCallbackNonce(event, window.location.origin, opener)
    if (!nonce || complete) return

    opener.postMessage(
      { type: 'ws-auth-probe-code', code, nonce },
      window.location.origin,
    )
    finish()
  }

  const timeout = window.setTimeout(() => {
    if (root) root.textContent = 'The sign-in handoff expired. You can close this window.'
    finish()
  }, 15_000)

  window.addEventListener('message', onMessage)
  opener.postMessage({ type: 'ws-auth-probe-callback-ready' }, window.location.origin)
}
