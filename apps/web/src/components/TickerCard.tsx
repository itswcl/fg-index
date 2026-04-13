import type { TickerQuote } from '../types';
import { formatAbsoluteTime } from '../services/time.utils';
import { Shimmer } from './Shimmer';

interface TickerCardProps {
  ticker: string;
  data: TickerQuote | null | undefined;
  lastUpdate: Date | null;
  isLoading?: boolean;
  isRefreshing?: boolean;
  isDark: boolean;
  onRemove: () => void;
}

export function TickerCard({
  ticker,
  data,
  lastUpdate,
  isLoading,
  isRefreshing,
  isDark,
  onRemove,
}: TickerCardProps) {
  const showLoading = isLoading || (isRefreshing && data === undefined);
  const showRefreshing = isRefreshing && data !== undefined;

  // data === null means loaded but ticker not found
  if (!isLoading && data === null) {
    return (
      <div className={`card card-custom ${isDark ? 'card-dark' : 'card-light'}`}>
        <button className="card-remove-btn" onClick={onRemove} onPointerDown={(e) => e.stopPropagation()} aria-label={`Remove ${ticker}`}>
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <div className="card-inner">
          <span className="card-label">{ticker}</span>
          <div className="price-container">
            <span className="na-text">–</span>
            <span className="na-subtext">Not Found</span>
          </div>
          <div className="footer-row" />
        </div>
      </div>
    );
  }

  const price = data?.price != null ? data.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '–';
  const change = data?.change ?? 0;
  const changePct = data?.changePercent ?? 0;
  const isPositive = change >= 0;
  // Standard stock coloring: green = up, red = down (opposite of VIX)
  const color = isPositive ? '#27AE60' : '#E74C3C';
  const arrow = isPositive ? '↑' : '↓';

  return (
    <div className={`card card-custom ${isDark ? 'card-dark' : 'card-light'}`}>
      <button className="card-remove-btn" onClick={onRemove} aria-label={`Remove ${ticker}`}>
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      <div className="card-inner">
        <span className="card-label">{ticker}</span>

        <div className="price-container">
          {(showRefreshing || showLoading) ? (
            <div className="shimmer-stack">
              <Shimmer width={90} height={38} borderRadius={8} />
              <Shimmer width={70} height={13} borderRadius={4} />
            </div>
          ) : (
            <>
              {data?.name && (
                <span className="ticker-name" style={{ color: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.4)' }}>
                  {data.name}
                </span>
              )}
              <span className={`price ${isDark ? '' : 'price-light'}`}>{price}</span>
              <div className="change-box">
                <span className="change" style={{ color }}>
                  {arrow} {Math.abs(change).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span className="change-pct" style={{ color }}>
                  {' '}({Math.abs(changePct).toFixed(2)}%)
                </span>
              </div>
            </>
          )}
        </div>

        <div className="footer-row">
          {(showRefreshing || showLoading) ? (
            <Shimmer width={110} height={8} borderRadius={2} />
          ) : lastUpdate ? (
            <span className={`updated-at ${isDark ? '' : 'updated-at-light'}`}>
              Updated {formatAbsoluteTime(lastUpdate)}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
