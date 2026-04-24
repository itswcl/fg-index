
import type { FearGreed, FearGreedClassification } from '../types';
import { FEAR_GREED_COLORS } from '../constants';
import { formatAbsoluteTime } from '../services/time.utils';
import { buildSourceLinkProps } from '../lib/openSourceLink';
import { CardShimmer } from './CardShimmer';
import { AnimatedNumber } from './AnimatedNumber';

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

  const label = data?.classification || 'Fear & Greed';
  const score = data?.score ?? '–';
  const color = getFearGreedColor(label);

  const linkProps = buildSourceLinkProps(data?.sourceUrl, 'Fear & Greed — open source');

  return (
    <div className={`card ${isDark ? 'card-dark' : 'card-light'}`} {...linkProps}>
      <div className="card-inner">
        <span className="card-label">Fear & Greed</span>

        {showLoading ? (
          <CardShimmer variant="score" />
        ) : (
          <>
            <div className="price-container">
              {typeof score === 'number' ? (
                <AnimatedNumber value={score} formatter={(n) => Math.round(n).toString()} className="price" style={{ color }} />
              ) : (
                <span className="price" style={{ color }}>{score}</span>
              )}
              <span className="classification" style={{ color }}>{label}</span>
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
