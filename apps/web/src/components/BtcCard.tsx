import type { TickerQuote } from '../types';
import { formatAbsoluteTime } from '../services/time.utils';
import { CardShimmer } from './CardShimmer';
import { AnimatedNumber } from './AnimatedNumber';

interface BtcCardProps {
  data: TickerQuote | null;
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

  const change = data?.change ?? 0;
  const changePct = data?.changePercent ?? 0;
  const isPositive = change >= 0;
  const color = isPositive ? '#27AE60' : '#E74C3C';
  const arrow = isPositive ? '↑' : '↓';

  return (
    <div className={`card ${isDark ? 'card-dark' : 'card-light'}`}>
      <div className="card-inner">
        <span className="card-label">BTC</span>

        {showLoading ? (
          <CardShimmer />
        ) : (
          <>
            <div className="price-container">
              {data ? (
                <AnimatedNumber value={data.price} formatter={formatBtcPrice} className={`price ${isDark ? '' : 'price-light'}`} />
              ) : (
                <span className={`price ${isDark ? '' : 'price-light'}`}>–</span>
              )}
              <div className="change-box">
                <AnimatedNumber value={Math.abs(change)} formatter={(n) => `${arrow} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} className="change" style={{ color }} />
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
