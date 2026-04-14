
import type { Vix } from '../types';
import { formatAbsoluteTime } from '../services/time.utils';
import { CardShimmer } from './CardShimmer';
import { AnimatedNumber } from './AnimatedNumber';

interface VixCardProps {
  data: Vix | null;
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

  const change = data?.change ?? 0;
  const changePct = data?.changePercent ?? 0;
  const isPositive = change >= 0;
  const color = isPositive ? '#E74C3C' : '#27AE60';
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
              {data?.price != null ? (
                <AnimatedNumber value={data.price} formatter={fmt2} className={`price ${isDark ? '' : 'price-light'}`} />
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
