import { isMarketWindowOpen } from '../../../../packages/shared-types/src/market-window';
import { useMarketWindow } from './useMarketWindow';
import { useQuery } from '@tanstack/react-query';
import type { TickerQuote } from '../types';
import { API_BASE_URL, SPX_REFETCH_INTERVAL_MS } from '../constants';
import { authFetch } from '../lib/authFetch';
import { sanitizeTickerQuote } from '../lib/marketData';

async function fetchSpx(): Promise<TickerQuote | null> {
  if (!isMarketWindowOpen()) throw new Error('Stock updates pause outside weekdays 6 AM–6 PM Pacific');
  const res = await authFetch(`${API_BASE_URL}/api/spx`);
  if (!res.ok) throw new Error('Failed to fetch SPX');
  return sanitizeTickerQuote(await res.json());
}

export function useSpx() {
  const marketWindowOpen = useMarketWindow();
  return useQuery<TickerQuote | null, Error>({
    enabled: marketWindowOpen,
    queryKey: ['spx'],
    queryFn: fetchSpx,
    refetchInterval: SPX_REFETCH_INTERVAL_MS,
    staleTime: SPX_REFETCH_INTERVAL_MS,
    retry: (attempt) => isMarketWindowOpen() && attempt < 2,
  });
}
