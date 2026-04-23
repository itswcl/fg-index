
import type { TickerQuote } from '../types';
import { formatAbsoluteTime } from '../services/time.utils';
import { hasFiniteNumber } from '../lib/marketData';
import { CardShimmer } from './CardShimmer';
import { AnimatedNumber } from './AnimatedNumber';

interface VixCardProps {
  data: TickerQuote | null;
  vixAvailable: boolean;
  lastUpdate: Date | null;
  isLoading?: boolean;
  isRefreshing?: boolean;
  isDark: boolean;
}

export function VixCard({ data, vixAvailable, lastUpdate, isLoading, isRefreshing, isDark }: VixCardProps) {
  const showLoading = isLoading || (isRefreshing && !data);

  if (!vixAvailable) {
    return (
      <div className={`card ${isDark ? 'card-dark' : 'card-light'}`}>
        <div className="card-inner">
          <span className="card-label">VIX</span>
          <div className="price-container">
            <span className="na-text">N/A</span>
            <span className="na-subtext">Market Closed</span>
          </div>
          <div className="footer-row">
            {lastUpdate && (
              <span className="updated-at">Last Close {lastUpdate.toLocaleTimeString()}</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Same defensive guards as TickerCard — sanitizeTickerQuote should reject
  // quotes missing any numeric field, but a stale cache entry or race during
  // refresh can still deliver a partial object. `.toFixed` on null throws and
  // blanks the whole page.
  const hasPrice = hasFiniteNumber(data?.price);
  const hasChange = hasFiniteNumber(data?.change);
  const hasChangePct = hasFiniteNumber(data?.changePercent);
  const change = hasChange ? (data!.change as number) : 0;
  const isPositive = change >= 0;
  // Match the direction-based ticker convention used by BtcCard/SpxCard:
  // up = green, down = red. (Previously inverted because "VIX up = fear",
  // but that fought with the adjacent ↑/↓ arrow and confused users.)
  const color = isPositive ? '#27AE60' : '#E74C3C';
  const arrow = isPositive ? '↑' : '↓';
  const fmt2 = (n: number) => n.toFixed(2);

  return (
    <div className={`card ${isDark ? 'card-dark' : 'card-light'}`}>
      <div className="card-inner">
        <span className="card-label">VIX</span>

        {showLoading ? (
          <CardShimmer />
        ) : (
          <>
            <div className="price-container">
              {hasPrice ? (
                <AnimatedNumber value={data!.price} formatter={fmt2} className={`price ${isDark ? '' : 'price-light'}`} />
              ) : (
                <span className={`price ${isDark ? '' : 'price-light'}`}>–</span>
              )}
              {hasChange && hasChangePct && (
                <div className="change-box">
                  <AnimatedNumber value={Math.abs(change)} formatter={(n) => `${arrow} ${n.toFixed(2)}`} className="change" style={{ color }} />
                  <AnimatedNumber value={Math.abs(data!.changePercent as number)} formatter={(n) => ` (${n.toFixed(2)}%)`} className="change-pct" style={{ color }} />
                </div>
              )}
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
