import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

/**
 * Supabase client used for browser auth flows (Google OAuth) and session access.
 *
 * When env vars are missing (e.g. local dev without Supabase configured), the
 * client is still constructed but auth methods will fail — we keep the export
 * non-null so consumers don't need to null-check everywhere. Sign-in UI should
 * be hidden in that case via `hasSupabaseConfig`.
 */
export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

/** True when both Supabase env vars are present. */
export const hasSupabaseConfig: boolean = !!SUPABASE_URL && !!SUPABASE_ANON_KEY;
