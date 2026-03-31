import { useQuery } from '@tanstack/react-query';
import type { FearGreed } from '../types';
import { API_BASE_URL, API_KEY } from '../constants';

async function fetchFearGreed(): Promise<FearGreed> {
  const headers: HeadersInit = {};
  if (API_KEY) headers['X-API-KEY'] = API_KEY;
  const res = await fetch(`${API_BASE_URL}/api/fear-greed`, { headers });
  if (!res.ok) throw new Error('Failed to fetch Fear & Greed');
  return res.json() as Promise<FearGreed>;
}

export function useFearGreed() {
  return useQuery<FearGreed, Error>({
    queryKey: ['fearGreed'],
    queryFn: fetchFearGreed,
    staleTime: 30 * 60 * 1000,
    retry: 2,
  });
}
