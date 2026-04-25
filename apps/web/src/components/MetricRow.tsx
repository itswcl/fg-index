import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { MarketSession } from '../types';
import { AnimatedNumber } from './AnimatedNumber';
import { MarketSessionBadge } from './MarketSessionBadge';
import { Shimmer } from './Shimmer';
import './MetricRow.css';

export interface MetricRowData {
  /** Unique id used by dnd-kit (same id as desktop: 'feargreed' | 'vix' | 'btc' | 'spx' | <ticker>). */
  id: string;
  /** Primary label ("FEAR & GREED", "VIX", "AAPL"). */
  label: string;
  /** Secondary label shown under the primary ("Greed", "Volatility", "Apple Inc."). Optional. */
  subLabel?: string;
  /** Number to display in the right-hand price slot. Null/undefined → em-dash placeholder. */
  value: number | null;
  /** Optional formatter for the value. Defaults to `.toFixed(2)`. */
  valueFormatter?: (n: number) => string;
  /** Optional explicit color for the value (used by F&G classification coloring). */
  valueColor?: string;
  /** Percent change; when provided renders the colored secondary line under the value. */
  changePercent?: number | null;
  /**
   * How change coloring should map to price direction.
   * - `standard`: positive = green, negative = red (stocks, BTC, SPX)
   * - `inverted`: positive = red,  negative = green (VIX — higher VIX = worse market)
   * - `none`:     skip the change line entirely (F&G)
   */
  changeMode?: 'standard' | 'inverted' | 'none';
  /** Loading state — renders shimmer placeholders for label sub-label and value. */
  isLoading?: boolean;
  /** Show "N/A — Market Closed" style state (VIX / SPX outside hours). */
  isNa?: boolean;
  /** When set (and not in edit mode), row becomes a link that opens this URL in a new tab. */
  sourceUrl?: string;
  /**
   * Market session of this row's quote. When `'pre'` or `'post'`, an
   * inline crescent moon glyph renders next to the label. Defaults to
   * `'regular'` (no moon) — F&G and BTC pass `'regular'` explicitly so
   * their rows never get a session flag.
   */
  marketSession?: MarketSession;
  /**
   * ISO timestamp of the quote — used by the moon glyph's tooltip to
   * show "last trade HH:MM ET". Only relevant when `marketSession` is
   * an extended-hours value.
   */
  fetchedAt?: string;
}

interface MetricRowProps extends MetricRowData {
  isDark: boolean;
  /** True while a parent has entered edit mode — reveals drag handle + delete affordance. */
  editMode: boolean;
  /** True only for user-added tickers. Default cards are not deletable. */
  isCustom: boolean;
  /** Called when user confirms deletion of a custom ticker. */
  onRemove?: (id: string) => void;
  /** Hairline divider below this row (false on the last row). */
  showDivider: boolean;
}

function defaultFormat(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function DragHandle({ isDark }: { isDark: boolean }) {
  const color = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.45)';
  return (
    <svg
      className="metric-row-handle-icon"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path d="M4 7h12M4 10h12M4 13h12" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function MetricRow(props: MetricRowProps) {
  const {
    id,
    label,
    subLabel,
    value,
    valueFormatter,
    valueColor,
    changePercent,
    changeMode = 'standard',
    isLoading,
    isNa,
    sourceUrl,
    marketSession,
    fetchedAt,
    isDark,
    editMode,
    isCustom,
    onRemove,
    showDivider,
  } = props;

  // Row is clickable only when we have a URL, we're not in edit mode, and the
  // ticker actually resolved (skip N/A / loading so a stray tap doesn't open
  // an empty tab).
  const isLinkable = !editMode && !isLoading && !isNa && !!sourceUrl;
  const handleActivate = () => {
    if (sourceUrl) window.open(sourceUrl, '_blank', 'noopener,noreferrer');
  };

  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // dnd-kit sortable — only actually wired inside <SortableContext>; outside of
  // an edit-mode list it's a no-op (attributes/listeners still return objects).
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !editMode,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    opacity: isDragging ? 0.4 : undefined,
  };

  const format = valueFormatter ?? defaultFormat;

  // Change-color resolution
  let changeColor: string | undefined;
  let arrow = '';
  if (changePercent != null && changeMode !== 'none') {
    if (changePercent > 0) {
      changeColor = changeMode === 'inverted' ? '#E74C3C' : '#27AE60';
      arrow = '↑';
    } else if (changePercent < 0) {
      changeColor = changeMode === 'inverted' ? '#27AE60' : '#E74C3C';
      arrow = '↓';
    } else {
      changeColor = '#8E8E93';
    }
  }

  const rowClasses = [
    'metric-row',
    isDark ? 'metric-row-dark' : 'metric-row-light',
    editMode ? 'metric-row-edit' : '',
    showDivider ? 'metric-row-divider' : '',
    isLinkable ? 'metric-row-linkable' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const linkProps = isLinkable
    ? {
        role: 'link' as const,
        tabIndex: 0,
        onClick: handleActivate,
        onKeyDown: (e: React.KeyboardEvent<HTMLLIElement>) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleActivate();
          }
        },
        'aria-label': `${label}${subLabel ? ` (${subLabel})` : ''} — open source`,
      }
    : undefined;

  return (
    <li ref={setNodeRef} style={style} className={rowClasses} {...linkProps}>
      {editMode && (
        <button
          type="button"
          className="metric-row-handle"
          aria-label={`Reorder ${label}`}
          {...attributes}
          {...listeners}
        >
          <DragHandle isDark={isDark} />
        </button>
      )}

      <div className="metric-row-label-zone">
        {isLoading ? (
          <>
            <Shimmer width={80} height={14} />
            <Shimmer width={60} height={10} />
          </>
        ) : (
          <>
            <span className="metric-row-label">
              {label}
              {/*
                Inline moon glyph per spec — sits right of the ticker
                label with a 4px gap (handled inside the badge). Hidden
                during loading / N/A states because we don't render this
                branch then. F&G and BTC pass `'regular'` so their badges
                no-op.
              */}
              {marketSession && (
                <MarketSessionBadge
                  session={marketSession}
                  isDark={isDark}
                  placement="inline"
                  fetchedAt={fetchedAt}
                />
              )}
            </span>
            {subLabel && <span className="metric-row-sub">{subLabel}</span>}
          </>
        )}
      </div>

      {confirmingDelete && editMode && isCustom ? (
        <div className="metric-row-confirm">
          <button
            type="button"
            className={`metric-row-confirm-cancel ${isDark ? 'is-dark' : 'is-light'}`}
            onClick={() => setConfirmingDelete(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="metric-row-confirm-delete"
            onClick={() => {
              setConfirmingDelete(false);
              onRemove?.(id);
            }}
          >
            Delete
          </button>
        </div>
      ) : (
        <div
          className={`metric-row-value-zone ${editMode ? 'metric-row-value-zone-dim' : ''}`}
        >
          {isLoading ? (
            <>
              <Shimmer width={60} height={16} />
              <Shimmer width={44} height={12} />
            </>
          ) : isNa ? (
            <>
              <span className="metric-row-value metric-row-value-na">N/A</span>
              <span className="metric-row-change metric-row-change-na">Market Closed</span>
            </>
          ) : (
            <>
              {value != null ? (
                <AnimatedNumber
                  value={value}
                  formatter={format}
                  className="metric-row-value"
                  style={valueColor ? { color: valueColor } : undefined}
                />
              ) : (
                <span className="metric-row-value">–</span>
              )}
              {changeMode !== 'none' && changePercent != null && (
                <span className="metric-row-change" style={{ color: changeColor }}>
                  {arrow} {Math.abs(changePercent).toFixed(2)}%
                </span>
              )}
            </>
          )}

          {editMode && isCustom && !confirmingDelete && (
            <button
              type="button"
              className="metric-row-delete"
              aria-label={`Delete ${label}`}
              onClick={() => setConfirmingDelete(true)}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="7" fill="#FF3B30" />
                <rect x="4" y="7.25" width="8" height="1.5" rx="0.75" fill="#fff" />
              </svg>
            </button>
          )}
        </div>
      )}
    </li>
  );
}
