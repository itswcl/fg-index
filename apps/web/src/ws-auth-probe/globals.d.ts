export {}

declare global {
  interface Window {
    __FG_INDEX_WS_AUTH_PROBE_CALLBACK__?: {
      code: string | null
      failed: boolean
    }
  }
}
