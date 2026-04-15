import { supabase, hasSupabaseConfig } from './supabase';
import { API_KEY } from '../constants';

/**
 * Fetch wrapper that auto-injects:
 *   - `Authorization: Bearer <access_token>` when a Supabase session exists
 *   - `X-API-KEY` when VITE_API_KEY is configured
 *
 * Use this for every call to our API so signed-in requests hit the
 * authenticated route and anonymous requests fall back to API key.
 */
export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});

  if (hasSupabaseConfig) {
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (token && !headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`);
      }
    } catch {
      // If session lookup fails, proceed without auth — backend will 401 if required.
    }
  }

  if (API_KEY && !headers.has('X-API-KEY')) {
    headers.set('X-API-KEY', API_KEY);
  }

  return fetch(input, { ...init, headers });
}

/**
 * Build a WebSocket URL with the current Supabase access token appended as
 * `?token=<jwt>` (and preserving `?apiKey=...` if already present). Returns
 * the base URL unchanged when no session exists.
 *
 * Browsers can't set headers on a WebSocket handshake, so the token must be
 * passed as a query param. The backend auth middleware reads it from there.
 */
export async function buildWsUrl(baseUrl: string): Promise<string> {
  const params = new URLSearchParams();

  if (API_KEY) params.set('apiKey', API_KEY);

  if (hasSupabaseConfig) {
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (token) params.set('token', token);
    } catch {
      // proceed without token
    }
  }

  const qs = params.toString();
  if (!qs) return baseUrl;
  return baseUrl.includes('?') ? `${baseUrl}&${qs}` : `${baseUrl}?${qs}`;
}
