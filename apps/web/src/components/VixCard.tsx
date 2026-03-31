
import type { Vix } from '../types';
import { formatAbsoluteTime } from '../services/time.utils';
import { Shimmer } from './Shimmer';

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
  const showRefreshing = isRefreshing && !!data;

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

  const price = data?.price ? data.price.toFixed(2) : '–';
  const change = data?.change ?? 0;
  const changePct = data?.changePercent ?? 0;
  const isPositive = change >= 0;
  const color = isPositive ? '#E74C3C' : '#27AE60';
  const arrow = isPositive ? '↑' : '↓';

  return (
    <div className={`card ${isDark ? 'card-dark' : 'card-light'}`}>
      <div className="card-inner">
        <span className="card-label">VIX</span>

        <div className="price-container">
          {(showRefreshing || showLoading) ? (
            <div className="shimmer-stack">
              <Shimmer width={90} height={38} borderRadius={8} />
              <Shimmer width={70} height={13} borderRadius={4} />
            </div>
          ) : (
            <>
              <span className={`price ${isDark ? '' : 'price-light'}`}>{price}</span>
              <div className="change-box">
                <span className="change" style={{ color }}>
                  {arrow} {Math.abs(change).toFixed(2)}
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
