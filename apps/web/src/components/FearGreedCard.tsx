
import type { FearGreed, FearGreedClassification } from '../types';
import { FEAR_GREED_COLORS } from '../constants';
import { formatAbsoluteTime } from '../services/time.utils';
import { Shimmer } from './Shimmer';

interface FearGreedCardProps {
  data: FearGreed | null;
  lastUpdate?: Date | null;
  isLoading?: boolean;
  isRefreshing?: boolean;
  isDark: boolean;
}

function getFearGreedColor(classification: FearGreedClassification | string): string {
  const key = classification as keyof typeof FEAR_GREED_COLORS;
  return FEAR_GREED_COLORS[key] || '#FFFFFF';
}

export function FearGreedCard({ data, lastUpdate, isLoading, isRefreshing, isDark }: FearGreedCardProps) {
  const showLoading = isLoading || (isRefreshing && !data);
  const showRefreshing = isRefreshing && !!data;

  const label = data?.classification || 'Fear & Greed';
  const score = data?.score ?? '–';
  const color = getFearGreedColor(label);

  return (
    <div className={`card ${isDark ? 'card-dark' : 'card-light'}`}>
      <div className="card-inner">
        <span className="card-label">Fear & Greed</span>

        <div className="price-container">
          {showLoading ? (
            <div className="shimmer-stack">
              <Shimmer width={70} height={38} borderRadius={8} />
              <Shimmer width={55} height={12} borderRadius={4} />
            </div>
          ) : (
            <>
              <span className="price" style={{ color }}>{score}</span>
              <span className="classification" style={{ color }}>{label}</span>
            </>
          )}
        </div>

        <div className="footer-row">
          {(showRefreshing || showLoading) ? (
            <Shimmer width={100} height={8} borderRadius={2} />
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
