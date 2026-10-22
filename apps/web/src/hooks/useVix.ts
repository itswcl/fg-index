import { isMarketWindowOpen } from '../../../../packages/shared-types/src/market-window';
import { useMarketWindow } from './useMarketWindow';
import { useQuery } from '@tanstack/react-query';
import type { TickerQuote } from '../types';
import { API_BASE_URL, VIX_REFETCH_INTERVAL_MS } from '../constants';
import { authFetch } from '../lib/authFetch';
import { sanitizeTickerQuote } from '../lib/marketData';

async function fetchVix(): Promise<TickerQuote | null> {
  const res = await authFetch(`${API_BASE_URL}/api/vix`);
  if (!res.ok) throw new Error('Failed to fetch VIX');
  return sanitizeTickerQuote(await res.json());
}

export function useVix() {
  const marketWindowOpen = useMarketWindow();
  return useQuery<TickerQuote | null, Error>({
    queryKey: ['vix'],
    queryFn: fetchVix,
    refetchInterval: marketWindowOpen ? VIX_REFETCH_INTERVAL_MS : false,
    staleTime: VIX_REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: marketWindowOpen,
    refetchOnReconnect: marketWindowOpen,
    retry: (attempt) => isMarketWindowOpen() && attempt < 2,
  });
}
