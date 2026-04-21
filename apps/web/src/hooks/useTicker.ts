import { useQuery } from '@tanstack/react-query';
import type { TickerQuote } from '../types';

/**
 * Pure cache reader. The actual ticker quotes are fetched in one batch per
 * page by `usePageTickers`, which writes each result into
 * `['ticker', symbol]`. This hook just subscribes to that cache key and
 * re-renders when the batch fans out.
 *
 * `enabled: false` keeps React Query from firing its own per-symbol
 * request — that's the whole point of FE-6 (cut N requests per page down
 * to 1). `queryFn` must still be declared for type soundness, but the
 * defensive throw is just in case someone flips `enabled` upstream.
 *
 * The synthesized `isLoading` flag restores the shimmer-during-first-paint
 * behavior that React Query's built-in `isLoading` loses under
 * `enabled: false`:
 *   - `undefined` ⇒ cache not seeded yet ⇒ show loading UI
 *   - `null`      ⇒ batch reported the symbol as unknown ⇒ show N/A UI
 *   - any object  ⇒ real quote data
 */
export function useTicker(ticker: string) {
  const query = useQuery<TickerQuote | null, Error>({
    queryKey: ['ticker', ticker],
    queryFn: () => {
      throw new Error(
        'useTicker is a cache reader; usePageTickers owns batch fetching. ' +
          'See apps/web/src/hooks/usePageTickers.ts.',
      );
    },
    enabled: false,
    staleTime: Infinity,
  });

  return {
    ...query,
    isLoading: query.data === undefined,
  };
}
