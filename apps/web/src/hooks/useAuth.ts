import { useEffect, useState, useCallback } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase, hasSupabaseConfig } from '../lib/supabase';

interface UseAuthReturn {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

/**
 * Hook that exposes the current Supabase session and sign-in/out actions.
 *
 * - Subscribes to auth state changes so UI updates on sign-in, sign-out,
 *   and token refresh.
 * - `signIn` uses Google OAuth and redirects back to the current page.
 * - When Supabase env vars are missing, the hook still returns safely but
 *   `signIn` is a no-op.
 */
export function useAuth(): UseAuthReturn {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    if (!hasSupabaseConfig) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      setLoading(false);
    });

    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async () => {
    if (!hasSupabaseConfig) return;
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + window.location.pathname,
      },
    });
  }, []);

  const signOut = useCallback(async () => {
    if (!hasSupabaseConfig) return;
    await supabase.auth.signOut();
  }, []);

  return {
    user: session?.user ?? null,
    session,
    loading,
    signIn,
    signOut,
  };
}
