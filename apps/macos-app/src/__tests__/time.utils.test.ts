import { isStale, formatRelativeTime } from '../services/time.utils';
import { STALENESS_THRESHOLD_MS } from '../constants';

describe('isStale', () => {
  it('returns true when lastUpdate is null', () => {
    expect(isStale(null)).toBe(true);
  });

  it('returns false when data is fresh', () => {
    const justNow = new Date();
    expect(isStale(justNow)).toBe(false);
  });

  it('returns true when data exceeds staleness threshold', () => {
    const old = new Date(Date.now() - STALENESS_THRESHOLD_MS - 1000);
    expect(isStale(old)).toBe(true);
  });
});

describe('formatRelativeTime', () => {
  it('returns "Never" for null', () => {
    expect(formatRelativeTime(null)).toBe('Never');
  });

  it('returns seconds for recent times', () => {
    const fiveSecondsAgo = new Date(Date.now() - 5000);
    expect(formatRelativeTime(fiveSecondsAgo)).toMatch(/\d+s ago/);
  });

  it('returns minutes for times over 60s ago', () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    expect(formatRelativeTime(twoMinutesAgo)).toBe('2m ago');
  });

  it('returns hours for times over 3600s ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    expect(formatRelativeTime(twoHoursAgo)).toBe('2h ago');
  });
});
