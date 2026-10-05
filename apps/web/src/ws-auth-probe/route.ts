export type EntryRoute = 'callback' | 'probe' | 'app'

export function resolveEntryRoute(input: {
  hasAuthCallbackContext: boolean
  wantsProbe: boolean
}): EntryRoute {
  if (input.hasAuthCallbackContext) return 'callback'
  if (input.wantsProbe) return 'probe'
  return 'app'
}
