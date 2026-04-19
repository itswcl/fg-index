import type { TickerQuote } from '../types';
import { formatAbsoluteTime } from '../services/time.utils';
import { CardShimmer } from './CardShimmer';
import { AnimatedNumber } from './AnimatedNumber';

interface SpxCardProps {
  data: TickerQuote | null;
  spxAvailable: boolean;
  lastUpdate: Date | null;
  isLoading?: boolean;
  isRefreshing?: boolean;
  isDark: boolean;
}

function formatSpxPrice(price: number): string {
  return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function SpxCard({ data, spxAvailable, lastUpdate, isLoading, isRefreshing, isDark }: SpxCardProps) {
  const showLoading = isLoading || (isRefreshing && !data);

  if (!spxAvailable) {
    return (
      <div className={`card ${isDark ? 'card-dark' : 'card-light'}`}>
        <div className="card-inner">
          <span className="card-label">S&P 500</span>
          <div className="price-container">
            <span className="na-text">N/A</span>
            <span className="na-subtext">Market Closed</span>
          </div>
          <div className="footer-row">
            {lastUpdate && (
              <span className={`updated-at ${isDark ? '' : 'updated-at-light'}`}>
                Last Close {formatAbsoluteTime(lastUpdate)}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  const change = data?.change ?? 0;
  const changePct = data?.changePercent ?? 0;
  const isPositive = change >= 0;
  const color = isPositive ? '#27AE60' : '#E74C3C';
  const arrow = isPositive ? '↑' : '↓';

  return (
    <div className={`card ${isDark ? 'card-dark' : 'card-light'}`}>
      <div className="card-inner">
        <span className="card-label">S&P 500</span>

        {showLoading ? (
          <CardShimmer />
        ) : (
          <>
            <div className="price-container">
              {data ? (
                <AnimatedNumber value={data.price} formatter={formatSpxPrice} className={`price ${isDark ? '' : 'price-light'}`} />
              ) : (
                <span className={`price ${isDark ? '' : 'price-light'}`}>–</span>
              )}
              <div className="change-box">
                <AnimatedNumber value={Math.abs(change)} formatter={(n) => `${arrow} ${n.toFixed(2)}`} className="change" style={{ color }} />
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
