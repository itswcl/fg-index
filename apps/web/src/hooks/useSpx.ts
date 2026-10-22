import { isMarketWindowOpen } from '../../../../packages/shared-types/src/market-window';
import { useMarketWindow } from './useMarketWindow';
import { useQuery } from '@tanstack/react-query';
import type { TickerQuote } from '../types';
import { API_BASE_URL, SPX_REFETCH_INTERVAL_MS } from '../constants';
import { authFetch } from '../lib/authFetch';
import { sanitizeTickerQuote } from '../lib/marketData';

async function fetchSpx(): Promise<TickerQuote | null> {
  const res = await authFetch(`${API_BASE_URL}/api/spx`);
  if (!res.ok) throw new Error('Failed to fetch SPX');
  return sanitizeTickerQuote(await res.json());
}

export function useSpx() {
  const marketWindowOpen = useMarketWindow();
  return useQuery<TickerQuote | null, Error>({
    queryKey: ['spx'],
    queryFn: fetchSpx,
    refetchInterval: marketWindowOpen ? SPX_REFETCH_INTERVAL_MS : false,
    staleTime: SPX_REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: marketWindowOpen,
    refetchOnReconnect: marketWindowOpen,
    retry: (attempt) => isMarketWindowOpen() && attempt < 2,
  });
}
