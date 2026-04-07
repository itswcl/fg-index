import { useQuery } from '@tanstack/react-query';
import type { Spx } from '../types';
import { API_BASE_URL, API_KEY, SPX_REFETCH_INTERVAL_MS } from '../constants';

async function fetchSpx(): Promise<Spx | null> {
  const headers: HeadersInit = {};
  if (API_KEY) headers['X-API-KEY'] = API_KEY;
  const res = await fetch(`${API_BASE_URL}/api/spx`, { headers });
  if (!res.ok) throw new Error('Failed to fetch SPX');
  return res.json() as Promise<Spx | null>;
}

export function useSpx() {
  return useQuery<Spx | null, Error>({
    queryKey: ['spx'],
    queryFn: fetchSpx,
    refetchInterval: SPX_REFETCH_INTERVAL_MS,
    staleTime: SPX_REFETCH_INTERVAL_MS,
    retry: 2,
  });
}
