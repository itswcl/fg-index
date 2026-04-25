import type { TickerQuote } from '../types';
import { formatAbsoluteTime } from '../services/time.utils';
import { hasFiniteNumber } from '../lib/marketData';
import { buildSourceLinkProps } from '../lib/openSourceLink';
import { getDisplayQuote, resolveMarketSession } from '../lib/marketSession';
import { CardShimmer } from './CardShimmer';
import { AnimatedNumber } from './AnimatedNumber';
import { MarketSessionBadge } from './MarketSessionBadge';

interface TickerCardProps {
  ticker: string;
  data: TickerQuote | null | undefined;
  lastUpdate: Date | null;
  isLoading?: boolean;
  isRefreshing?: boolean;
  isDark: boolean;
  onRemove: () => void;
}

export function TickerCard({
  ticker,
  data,
  lastUpdate,
  isLoading,
  isRefreshing,
  isDark,
  onRemove,
}: TickerCardProps) {
  const showLoading = isLoading || (isRefreshing && data === undefined);
  const linkProps = buildSourceLinkProps(
    data?.sourceUrl,
    `${ticker}${data?.name ? ` (${data.name})` : ''} — open source`,
  );

  // data === null means loaded but ticker not found
  if (!isLoading && data === null) {
    return (
      <div className={`card card-custom ${isDark ? 'card-dark' : 'card-light'}`}>
        <button
          className="card-remove-btn"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={`Remove ${ticker}`}
        >
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <div className="card-inner">
          <span className="card-label">{ticker}</span>
          <div className="price-container">
            <span className="na-text">–</span>
            <span className="na-subtext">Not Found</span>
          </div>
          <div className="footer-row" />
        </div>
      </div>
    );
  }

  // Hide moon during shimmer / partial-data states; only flag a session
  // we trust. `withRemoveButton` shifts the moon left so it never collides
  // with the hover-reveal red × button on `.card-custom`.
  //
  // During post/pre we paint the extended-hours triplet (postMarketPrice +
  // postMarketChange + postMarketChangePercent). getDisplayQuote falls
  // back to the regular triplet if the corresponding extended-hours
  // fields aren't present, so a quote with `marketSession: 'post'` but
  // missing `postMarketPrice` (e.g. Yahoo cooldown) keeps showing the
  // regular last-trade rather than blanking.
  const session = !showLoading && data ? resolveMarketSession(data) : 'regular';
  const display = getDisplayQuote(data, session);

  // Defensive: previous "null quote crash" fix hardened BtcCard/SpxCard/VixCard
  // with hasFiniteNumber but missed this component — and TickerCard renders for
  // every custom ticker, so any non-finite field that slips past sanitizeTickerQuote
  // (e.g. from a stale cache entry) would reach toLocaleString/toFixed below and
  // blow up the whole page. Gate each numeric field so a partial quote still
  // renders a safe em-dash instead of crashing.
  const hasPrice = hasFiniteNumber(display?.price);
  const hasChange = hasFiniteNumber(display?.change);
  const hasChangePct = hasFiniteNumber(display?.changePercent);
  const change = hasChange ? (display!.change as number) : 0;
  const isPositive = change >= 0;
  // Standard stock coloring: green = up, red = down (opposite of VIX)
  const color = isPositive ? '#27AE60' : '#E74C3C';
  const arrow = isPositive ? '↑' : '↓';
  const fmtPrice = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className={`card card-custom ${isDark ? 'card-dark' : 'card-light'}`} {...linkProps}>
      <MarketSessionBadge
        session={session}
        isDark={isDark}
        placement="corner"
        withRemoveButton
        fetchedAt={data?.fetchedAt}
      />
      <button
        className="card-remove-btn"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label={`Remove ${ticker}`}
      >
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      <div className="card-inner">
        <span className="card-label">{ticker}</span>

        {showLoading ? (
          <CardShimmer />
        ) : (
          <>
            <div className="price-container">
              {data?.name && (
                <span className="ticker-name" style={{ color: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.4)' }}>
                  {data.name}
                </span>
              )}
              {hasPrice ? (
                <AnimatedNumber value={display!.price} formatter={fmtPrice} className={`price ${isDark ? '' : 'price-light'}`} />
              ) : (
                <span className={`price ${isDark ? '' : 'price-light'}`}>–</span>
              )}
              {hasChange && hasChangePct && (
                <div className="change-box">
                  <AnimatedNumber value={Math.abs(change)} formatter={(n) => `${arrow} ${fmtPrice(n)}`} className="change" style={{ color }} />
                  <AnimatedNumber value={Math.abs(display!.changePercent)} formatter={(n) => ` (${n.toFixed(2)}%)`} className="change-pct" style={{ color }} />
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
