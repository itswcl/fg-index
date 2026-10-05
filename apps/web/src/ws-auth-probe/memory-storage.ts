export function createMemoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem(key: string): string | null {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string): void {
      values.set(key, value)
    },
    removeItem(key: string): void {
      values.delete(key)
    },
    clear(): void {
      values.clear()
    },
  }
}
