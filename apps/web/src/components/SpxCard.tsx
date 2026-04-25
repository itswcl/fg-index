import type { TickerQuote } from '../types';
import { formatAbsoluteTime } from '../services/time.utils';
import { hasFiniteNumber } from '../lib/marketData';
import { buildSourceLinkProps } from '../lib/openSourceLink';
import { getDisplayQuote, resolveMarketSession } from '../lib/marketSession';
import { CardShimmer } from './CardShimmer';
import { AnimatedNumber } from './AnimatedNumber';
import { MarketSessionBadge } from './MarketSessionBadge';

interface SpxCardProps {
  data: TickerQuote | null;
  lastUpdate: Date | null;
  isLoading?: boolean;
  isRefreshing?: boolean;
  isDark: boolean;
}

function formatSpxPrice(price: number): string {
  return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function SpxCard({ data, lastUpdate, isLoading, isRefreshing, isDark }: SpxCardProps) {
  // No "Market Closed" branch by design — see VixCard for the rationale.
  // Once we have any value, a later null payload from the server is
  // ignored upstream and the last known price keeps showing.
  const showLoading = isLoading || (isRefreshing && !data);

  // See VixCard for moon-glyph rationale. SPX is a computed index so the
  // backend may not always populate `marketSession`; the ET-derived
  // fallback inside resolveMarketSession handles that path. We route
  // through getDisplayQuote so any future post/pre prints surface the
  // extended-hours numbers; today they almost always fall back to
  // regular because indices aren't traded.
  const session = !showLoading && data ? resolveMarketSession(data) : 'regular';
  const display = getDisplayQuote(data, session);
  const change = display?.change ?? 0;
  const changePct = display?.changePercent ?? 0;
  const isPositive = change >= 0;
  const color = isPositive ? '#27AE60' : '#E74C3C';
  const arrow = isPositive ? '↑' : '↓';

  const linkProps = buildSourceLinkProps(data?.sourceUrl, 'S&P 500 — open source');

  return (
    <div className={`card ${isDark ? 'card-dark' : 'card-light'}`} {...linkProps}>
      <MarketSessionBadge
        session={session}
        isDark={isDark}
        placement="corner"
        fetchedAt={data?.fetchedAt}
      />
      <div className="card-inner">
        <span className="card-label">S&P 500</span>

        {showLoading ? (
          <CardShimmer />
        ) : (
          <>
            <div className="price-container">
              {display && hasFiniteNumber(display.price) ? (
                <AnimatedNumber value={display.price} formatter={formatSpxPrice} className={`price ${isDark ? '' : 'price-light'}`} />
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
