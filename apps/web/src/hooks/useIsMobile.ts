import { useEffect, useState } from 'react';

/**
 * Subscribes to a CSS media query and returns whether it currently matches.
 *
 * SSR-safe (returns `false` until mounted in the browser). Uses the modern
 * `addEventListener` API on `MediaQueryList` and falls back to `addListener`
 * for older Safari.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);

    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    // Safari < 14 fallback
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query]);

  return matches;
}

/**
 * True when the viewport is in the "mobile line-items" layout range.
 * Matches the hard breakpoint in `docs/mobile-layout-spec.md`.
 */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 639px)');
}

/**
 * True on very narrow phones (iPhone SE class). Drives the header's
 * search-collapse mode and the "hide ☕ and 🔔 behind overflow" rule.
 */
export function useIsNarrow(): boolean {
  return useMediaQuery('(max-width: 419px)');
}
