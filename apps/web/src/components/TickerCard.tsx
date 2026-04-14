import type { TickerQuote } from '../types';
import { formatAbsoluteTime } from '../services/time.utils';
import { CardShimmer } from './CardShimmer';
import { AnimatedNumber } from './AnimatedNumber';

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

  const change = data?.change ?? 0;
  const changePct = data?.changePercent ?? 0;
  const isPositive = change >= 0;
  // Standard stock coloring: green = up, red = down (opposite of VIX)
  const color = isPositive ? '#27AE60' : '#E74C3C';
  const arrow = isPositive ? '↑' : '↓';
  const fmtPrice = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

        {showLoading ? (
          <CardShimmer />
        ) : (
          <>
            <div className="price-container">
              {data?.name && (
                <span className="ticker-name" style={{ color: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.4)' }}>
                  {data.name}
                </span>
              )}
              {data?.price != null ? (
                <AnimatedNumber value={data.price} formatter={fmtPrice} className={`price ${isDark ? '' : 'price-light'}`} />
              ) : (
                <span className={`price ${isDark ? '' : 'price-light'}`}>–</span>
              )}
              <div className="change-box">
                <AnimatedNumber value={Math.abs(change)} formatter={(n) => `${arrow} ${fmtPrice(n)}`} className="change" style={{ color }} />
                <AnimatedNumber value={Math.abs(changePct)} formatter={(n) => ` (${n.toFixed(2)}%)`} className="change-pct" style={{ color }} />
              </div>
            </div>
            <div className="footer-row">
              {lastUpdate && (
                <span className={`updated-at ${isDark ? '' : 'updated-at-light'}`}>
                  Updated {formatAbsoluteTime(lastUpdate)}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
