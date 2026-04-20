import { useCallback, useEffect, useState } from 'react';

/**
 * URL-bound pagination state. Source of truth is `?page=N` in the address
 * bar (1-indexed, omitted on page 1). `setPage` does a `history.replaceState`
 * so it doesn't pollute the back-forward stack on every dot tap — users only
 * build up history when they deliberately deep-link via a new URL. A
 * `popstate` listener keeps state in sync with browser back/forward.
 *
 * No router dep — works in a pure-React app.
 */

function readPageFromUrl(): number {
  if (typeof window === 'undefined') return 1;
  const raw = new URLSearchParams(window.location.search).get('page');
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function writePageToUrl(page: number): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  if (page <= 1) params.delete('page');
  else params.set('page', String(page));
  const qs = params.toString();
  const url = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
  window.history.replaceState(null, '', url);
}

export interface UsePaginationResult {
  /** 1-indexed current page. */
  page: number;
  /** Clamps to `[1, pageCount]` then mirrors to the URL. */
  setPage: (p: number) => void;
  pageCount: number;
  canPrev: boolean;
  canNext: boolean;
}

export function usePagination(
  totalItems: number,
  opts: { perPage: number },
): UsePaginationResult {
  const { perPage } = opts;
  const pageCount = Math.max(1, Math.ceil(Math.max(totalItems, 0) / perPage));

  const [page, setPageState] = useState<number>(() => {
    const initial = readPageFromUrl();
    const initialPageCount = Math.max(
      1,
      Math.ceil(Math.max(totalItems, 0) / perPage),
    );
    return Math.min(Math.max(1, initial), initialPageCount);
  });

  // Clamp when the total shrinks (e.g. cards deleted) so we never render a
  // page that no longer exists.
  useEffect(() => {
    if (page > pageCount) {
      setPageState(pageCount);
      writePageToUrl(pageCount);
    }
  }, [page, pageCount]);

  // Browser back/forward — re-read the URL and sync.
  useEffect(() => {
    function handler() {
      const urlPage = readPageFromUrl();
      setPageState(Math.min(Math.max(1, urlPage), pageCount));
    }
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [pageCount]);

  const setPage = useCallback(
    (p: number) => {
      const clamped = Math.min(Math.max(1, p), pageCount);
      setPageState(clamped);
      writePageToUrl(clamped);
    },
    [pageCount],
  );

  return {
    page,
    setPage,
    pageCount,
    canPrev: page > 1,
    canNext: page < pageCount,
  };
}
