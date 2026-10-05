export interface DeadlineScheduler {
  setTimeout(callback: () => void, delayMs: number): number
  clearTimeout(handle: number): void
}

export interface AttemptDeadline {
  isActive(): boolean
  clear(): void
}

export function createAttemptDeadline(
  onExpire: () => void,
  scheduler: DeadlineScheduler,
  delayMs: number,
): AttemptDeadline {
  let active = true
  const handle = scheduler.setTimeout(() => {
    if (!active) return
    active = false
    onExpire()
  }, delayMs)

  return {
    isActive: () => active,
    clear: () => {
      if (!active) return
      active = false
      scheduler.clearTimeout(handle)
    },
  }
}

export async function exchangeWithinAttempt<T>(
  exchange: () => Promise<T | null>,
  deadline: AttemptDeadline,
  accept: (value: T) => void,
  clearTransientState: () => void,
): Promise<'accepted' | 'failed' | 'expired'> {
  let value: T | null
  try {
    value = await exchange()
  } catch (error) {
    clearTransientState()
    throw error
  }

  if (!deadline.isActive()) {
    value = null
    clearTransientState()
    return 'expired'
  }
  if (value === null) {
    clearTransientState()
    return 'failed'
  }

  try {
    deadline.clear()
    accept(value)
    return 'accepted'
  } finally {
    value = null
    clearTransientState()
  }
}
