import type { KeyboardEvent, CSSProperties } from 'react';

/**
 * Click-to-open-source props for card roots. Builds the same link-like
 * affordance that TickerCard has used for a while — extracted so the
 * default indicator cards (F&G / VIX / BTC / SPX) can share the same
 * behavior without copy-pasting the handler + keyboard + aria plumbing.
 *
 * Returns `undefined` when there's no `sourceUrl` so callers can spread
 * it conditionally with `{...linkProps}` and have the card fall back to
 * its original non-interactive shell.
 *
 * Notes:
 *   - `role="link"` + `tabIndex={0}` + Enter/Space keyboard handling
 *     makes the card reachable and operable without a mouse.
 *   - `noopener,noreferrer` is required whenever we pass a user-visible
 *     URL to `window.open` to prevent tabnabbing / referrer leakage.
 *   - dnd-kit fires a final click at the end of a drag; in practice
 *     React's click vs. drag delta handling plus `touchAction: none` on
 *     the sortable wrapper means we don't see spurious opens, matching
 *     TickerCard's behavior.
 */
export interface SourceLinkProps {
  role: 'link';
  tabIndex: 0;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  style: CSSProperties;
  'aria-label': string;
}

export function buildSourceLinkProps(
  sourceUrl: string | undefined,
  ariaLabel: string,
): SourceLinkProps | undefined {
  if (!sourceUrl) return undefined;
  const open = () => {
    window.open(sourceUrl, '_blank', 'noopener,noreferrer');
  };
  return {
    role: 'link',
    tabIndex: 0,
    onClick: open,
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    },
    style: { cursor: 'pointer' },
    'aria-label': ariaLabel,
  };
}
