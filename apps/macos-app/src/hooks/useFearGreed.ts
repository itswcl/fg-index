import { useQuery } from '@tanstack/react-query';
import { FearGreed } from '@shared/types';
import { API_BASE_URL } from '../constants';

async function fetchFearGreed(): Promise<FearGreed> {
  const res = await fetch(`${API_BASE_URL}/api/fear-greed`);
  if (!res.ok) throw new Error('Failed to fetch Fear & Greed');
  return res.json();
}

/**
 * HTTP fallback hook for F&G — used when WS is unavailable.
 * Cached by server for 30 min; staleTime mirrors that.
 */
export function useFearGreed() {
  return useQuery<FearGreed, Error>({
    queryKey: ['fearGreed'],
    queryFn: fetchFearGreed,
    staleTime: 30 * 60 * 1000, // 30 min — mirrors server Cache-Control
    retry: 2,
  });
}
