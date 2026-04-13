import type { Btc } from '../types';
import { formatAbsoluteTime } from '../services/time.utils';
import { CardShimmer } from './CardShimmer';

interface BtcCardProps {
  data: Btc | null;
  lastUpdate: Date | null;
  isLoading?: boolean;
  isRefreshing?: boolean;
  isDark: boolean;
}

function formatBtcPrice(price: number): string {
  if (price >= 1000) return `$${(price / 1000).toFixed(1)}K`;
  if (price >= 100) return `$${price.toFixed(1)}`;
  return `$${price.toFixed(2)}`;
}

export function BtcCard({ data, lastUpdate, isLoading, isRefreshing, isDark }: BtcCardProps) {
  const showLoading = isLoading || (isRefreshing && !data);
  const showRefreshing = isRefreshing && !!data;

  const change = data?.change ?? 0;
  const changePct = data?.changePercent ?? 0;
  const isPositive = change >= 0;
  const color = isPositive ? '#27AE60' : '#E74C3C';
  const arrow = isPositive ? '↑' : '↓';

  return (
    <div className={`card ${isDark ? 'card-dark' : 'card-light'}`}>
      <div className="card-inner">
        <span className="card-label">BTC</span>

        {(showRefreshing || showLoading) ? (
          <CardShimmer />
        ) : (
          <>
            <div className="price-container">
              <span className={`price ${isDark ? '' : 'price-light'}`}>
                {data ? formatBtcPrice(data.price) : '–'}
              </span>
              <div className="change-box">
                <span className="change" style={{ color }}>
                  {arrow} {Math.abs(change).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span className="change-pct" style={{ color }}>
                  {' '}({Math.abs(changePct).toFixed(2)}%)
                </span>
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
