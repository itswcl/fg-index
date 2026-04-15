import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { hasSupabaseConfig } from '../lib/supabase';

interface SignInButtonProps {
  isDark: boolean;
}

/**
 * Sign-in / account button shown in the top-right icon bar.
 *
 * - Signed out: shows "Sign in with Google" (Google G icon).
 * - Signed in: shows avatar (Google profile picture fallback to initial);
 *   clicking opens a dropdown with email and Sign out.
 * - Hidden when Supabase env vars aren't configured (local dev w/o auth).
 */
export function SignInButton({ isDark }: SignInButtonProps) {
  const { user, signIn, signOut, loading } = useAuth();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  if (!hasSupabaseConfig) return null;
  if (loading) return null;

  const iconColor = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.40)';

  // Signed out — show Google sign-in
  if (!user) {
    return (
      <button
        className={`icon-btn ${isDark ? 'icon-btn-dark' : 'icon-btn-light'}`}
        onClick={() => { void signIn(); }}
        aria-label="Sign in with Google"
      >
        {/* Google "G" mark */}
        <svg width="15" height="15" viewBox="0 0 48 48" aria-hidden="true">
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
          <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
        </svg>
        <span className={`tooltip ${isDark ? 'tooltip-dark' : 'tooltip-light'}`}>Sign in</span>
      </button>
    );
  }

  // Signed in — avatar + dropdown
  const avatarUrl = (user.user_metadata?.avatar_url as string | undefined) ?? null;
  const email = user.email ?? '';
  const initial = (email[0] ?? user.id[0] ?? '?').toUpperCase();

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        className={`icon-btn ${isDark ? 'icon-btn-dark' : 'icon-btn-light'}`}
        onClick={() => setOpen(v => !v)}
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            width={20}
            height={20}
            style={{ borderRadius: '50%', display: 'block' }}
            referrerPolicy="no-referrer"
          />
        ) : (
          <span
            aria-hidden="true"
            style={{
              width: 20,
              height: 20,
              borderRadius: '50%',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 11,
              fontWeight: 700,
              background: isDark ? 'rgba(95,127,255,0.35)' : 'rgba(95,127,255,0.2)',
              color: iconColor,
            }}
          >
            {initial}
          </span>
        )}
        <span className={`tooltip tooltip-right ${isDark ? 'tooltip-dark' : 'tooltip-light'}`}>Account</span>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: 200,
            padding: 8,
            borderRadius: 12,
            background: isDark ? 'rgba(28,28,30,0.98)' : 'rgba(255,255,255,0.98)',
            border: `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}`,
            boxShadow: isDark
              ? '0 12px 28px rgba(0,0,0,0.5)'
              : '0 12px 28px rgba(0,0,0,0.15)',
            zIndex: 100,
          }}
        >
          {email && (
            <div
              style={{
                padding: '6px 10px',
                fontSize: 12,
                color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)',
                borderBottom: `1px solid ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'}`,
                marginBottom: 4,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={email}
            >
              {email}
            </div>
          )}
          <button
            role="menuitem"
            onClick={() => { setOpen(false); void signOut(); }}
            style={{
              width: '100%',
              textAlign: 'left',
              padding: '8px 10px',
              border: 'none',
              background: 'transparent',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 500,
              color: isDark ? '#FFFFFF' : '#000000',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
