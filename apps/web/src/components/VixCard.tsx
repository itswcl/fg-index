
import type { TickerQuote } from '../types';
import { formatAbsoluteTime } from '../services/time.utils';
import { hasFiniteNumber } from '../lib/marketData';
import { buildSourceLinkProps } from '../lib/openSourceLink';
import { resolveMarketSession } from '../lib/marketSession';
import { CardShimmer } from './CardShimmer';
import { AnimatedNumber } from './AnimatedNumber';
import { MarketSessionBadge } from './MarketSessionBadge';

interface VixCardProps {
  data: TickerQuote | null;
  lastUpdate: Date | null;
  isLoading?: boolean;
  isRefreshing?: boolean;
  isDark: boolean;
}

export function VixCard({ data, lastUpdate, isLoading, isRefreshing, isDark }: VixCardProps) {
  // No "Market Closed" branch by design. Once we have any value — from
  // localStorage hydration or a live WS tick — a later null payload is
  // ignored upstream in `useMarketIndicators`, so the card keeps showing
  // the last known price with its `Updated HH:MM:SS` footer. The first-
  // ever visit with zero cached data falls through to the loading
  // shimmer below until the first WS message arrives.
  const showLoading = isLoading || (isRefreshing && !data);

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

  const linkProps = buildSourceLinkProps(data?.sourceUrl, 'VIX — open source');

  // Hide the moon during loading or when there's no data — never flag a
  // session against shimmer/empty (per spec). VIX is a US-equity-hours
  // index, so we trust the backend `marketSession` and fall back to the
  // ET-derived value if it's missing.
  const session = !showLoading && data ? resolveMarketSession(data) : 'regular';

  return (
    <div className={`card ${isDark ? 'card-dark' : 'card-light'}`} {...linkProps}>
      <MarketSessionBadge
        session={session}
        isDark={isDark}
        placement="corner"
        fetchedAt={data?.fetchedAt}
      />
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
