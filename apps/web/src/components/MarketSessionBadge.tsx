import type { CSSProperties } from 'react';
import type { MarketSession } from '../types';
import { isExtendedHoursSession } from '../lib/marketSession';

/**
 * Crescent-moon glyph that flags an extended-hours quote.
 *
 * Renders `null` for `'regular'` and `'closed'` — the spec says "never show
 * a session flag against non-data" and regular hours don't need a flag —
 * so callers can drop `<MarketSessionBadge ... />` into any card without
 * guarding the session themselves.
 *
 * Two placements:
 *   - `'corner'`: absolute top-right inside a card. On `.card-custom` the
 *     hover-reveal red × button lives at right:8px, so we shift the moon
 *     left by 22px (to right:32px) when `withRemoveButton` is true to avoid
 *     a collision once the user hovers.
 *   - `'inline'`: 12×12 sibling glyph for the mobile metric row, sits
 *     beside the ticker name with a 4px left margin (no absolute
 *     positioning — change% already owns the right edge of the row).
 *
 * One glyph covers both pre and post sessions; the tooltip / aria-label
 * disambiguates so screen readers announce the session correctly. If we
 * ever ship a separate pre-market affordance (sunrise) we can swap shapes
 * here without touching every card.
 *
 * Color uses the existing muted-grey token family — no accent color, this
 * is an ambient context flag, not a CTA. Hover-on-card boosts contrast via
 * the same currentColor handoff that the remove-button uses.
 */
interface MarketSessionBadgeProps {
  session: MarketSession;
  isDark: boolean;
  /**
   * `'corner'` for desktop card corners (absolute position).
   * `'inline'` for mobile metric rows (flow position).
   */
  placement?: 'corner' | 'inline';
  /**
   * Only meaningful for `placement='corner'`. When true, shifts the badge
   * left to make room for the `.card-remove-btn` at right:8px on hover.
   */
  withRemoveButton?: boolean;
  /** Shift farther left when another utility button sits before remove. */
  withGroupButton?: boolean;
  /**
   * ISO timestamp of the print, used to populate the tooltip's "last trade"
   * suffix in ET. Optional; without it we drop the timestamp clause.
   */
  fetchedAt?: string;
}

const CORNER_DARK = 'rgba(255, 255, 255, 0.55)';
const CORNER_LIGHT = 'rgba(0, 0, 0, 0.42)';

/**
 * Format an ISO timestamp into "HH:MM ET" for the tooltip. Returns
 * `undefined` on parse failure so the title falls back to the bare
 * session label rather than rendering "Invalid Date".
 */
function formatEtTime(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return fmt.format(date);
  } catch {
    return undefined;
  }
}

export function MarketSessionBadge({
  session,
  isDark,
  placement = 'corner',
  withRemoveButton = false,
  withGroupButton = false,
  fetchedAt,
}: MarketSessionBadgeProps) {
  // Only render for the two extended-hours sessions. `'regular'` and
  // `'closed'` deliberately render nothing — see file header.
  if (!isExtendedHoursSession(session)) return null;

  const isPre = session === 'pre';
  const label = isPre ? 'Pre-market price' : 'After-hours price';
  const sessionWord = isPre ? 'Pre-market' : 'After-hours';
  const time = formatEtTime(fetchedAt);
  const title = time ? `${sessionWord} — last trade ${time} ET` : sessionWord;

  // Geometry per spec: 16×16 corner / 12×12 inline, stroke-only crescent.
  // viewBox stays 16×16 so the same SVG path scales between placements.
  const size = placement === 'corner' ? 16 : 12;

  // Color resolves via `currentColor` so card-hover styles in App.css can
  // bump the opacity without us re-rendering the SVG.
  const baseColor = isDark ? CORNER_DARK : CORNER_LIGHT;

  const cornerStyle: CSSProperties = {
    position: 'absolute',
    top: 10,
    // `.card-custom` reveals a red × at right:8px on hover. Shift the moon
    // 22px left so both glyphs are visible and non-overlapping.
    right: withGroupButton ? 56 : withRemoveButton ? 32 : 10,
    width: size,
    height: size,
    color: baseColor,
    zIndex: 1,
    pointerEvents: 'none',
    // Mount fade per spec: 180ms ease-out from 0 → 1. We rely on React
    // mount/unmount triggering this; React's reconciler unmounts the node
    // when session flips back to regular, so the fade-out matches the
    // 120ms unmount transition CSS-side via opacity transition.
    opacity: 1,
    transition: 'opacity 180ms ease-out',
  };

  const inlineStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    width: size,
    height: size,
    marginLeft: 4,
    color: baseColor,
    flexShrink: 0,
    verticalAlign: 'middle',
    pointerEvents: 'none',
  };

  const style = placement === 'corner' ? cornerStyle : inlineStyle;

  return (
    <span
      className="market-session-badge"
      role="img"
      aria-label={label}
      title={title}
      style={style}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {/*
          Crescent moon: a single closed path approximating the Heroicons /
          Phosphor "moon" shape. Drawn as a left-leaning cup so it reads as
          "night" without looking like a logo.
        */}
        <path d="M13.5 10.5A6 6 0 0 1 5.5 2.5a6 6 0 1 0 8 8z" />
      </svg>
    </span>
  );
}
