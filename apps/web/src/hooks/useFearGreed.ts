import { isMarketWindowOpen } from '../../../../packages/shared-types/src/market-window';
import { useMarketWindow } from './useMarketWindow';
import { useQuery } from '@tanstack/react-query';
import type { FearGreed } from '../types';
import { API_BASE_URL } from '../constants';
import { authFetch } from '../lib/authFetch';

async function fetchFearGreed(): Promise<FearGreed> {
  if (!isMarketWindowOpen()) throw new Error('Stock updates pause outside weekdays 6 AM–6 PM Pacific');
  const res = await authFetch(`${API_BASE_URL}/api/fear-greed`);
  if (!res.ok) throw new Error('Failed to fetch Fear & Greed');
  return res.json() as Promise<FearGreed>;
}

export function useFearGreed() {
  const marketWindowOpen = useMarketWindow();
  return useQuery<FearGreed, Error>({
    enabled: marketWindowOpen,
    queryKey: ['fearGreed'],
    queryFn: fetchFearGreed,
    staleTime: 30 * 60 * 1000,
    retry: (attempt) => isMarketWindowOpen() && attempt < 2,
  });
}
