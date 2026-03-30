import { STALENESS_THRESHOLD_MS } from '../constants';

/**
 * Returns true if the given timestamp is older than STALENESS_THRESHOLD_MS.
 */
export function isStale(lastUpdate: Date | null): boolean {
  if (!lastUpdate) return true;
  return Date.now() - lastUpdate.getTime() > STALENESS_THRESHOLD_MS;
}

/**
 * Formats a relative time string for display (e.g. "2m ago").
 */
export function formatRelativeTime(date: Date | null): string {
  if (!date) return 'Never';
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

/**
 * Formats a Date object to a time string like "03:04:15 PM".
 */
export function formatAbsoluteTime(date: Date | null): string {
  if (!date) return 'Never';
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
