import { useCallback, useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { hydrateQuoteCacheIntoQueryClient } from './lib/quoteCache';
import { useMarketIndicators } from './hooks/useMarketIndicators';
import { useFearGreed } from './hooks/useFearGreed';
import { useVix } from './hooks/useVix';
import { useBtc } from './hooks/useBtc';
import { useSpx } from './hooks/useSpx';
import { useTheme } from './hooks/useTheme';
import { useUnifiedOrder } from './hooks/useUnifiedOrder';
import { useTickerSync } from './hooks/useTickerSync';
import { usePreferencesSync } from './hooks/usePreferencesSync';
import { useAlerts } from './hooks/useAlerts';
import { CardGrid } from './components/CardGrid';
import { MobileMetricList } from './components/MobileMetricList';
import { IconBar } from './components/IconBar';
import { AlertsPopup } from './components/AlertsPopup';
import { AddTickerInput } from './components/AddTickerInput';
import { PageIndicator } from './components/PageIndicator';
import { usePagination } from './hooks/usePagination';
import { CARDS_PER_PAGE } from './constants';
import { useIsMobile, useIsNarrow } from './hooks/useIsMobile';
import type { AlertTriggeredMessage } from './types/alerts';
import type { FearGreed, TickerQuote } from './types';
import './App.css';

const queryClient = new QueryClient();
// Seed every ['ticker', SYMBOL] cache entry from localStorage before the
// tree first renders, so custom ticker cards paint last-known prices on
// reload instead of flashing shimmer / "Not Found" while the batch
// request is in flight. Live fetches overwrite as they arrive.
hydrateQuoteCacheIntoQueryClient(queryClient);

function MarketIndicators() {
  const {
    alerts,
    addAlert,
    updateAlert,
    deleteAlert,
    toggleAlert,
    isAnonymous: alertsAnonymous,
    migrationCandidate: alertsMigrationCandidate,
    acceptMigration: acceptAlertsMigration,
    dismissMigration: dismissAlertsMigration,
  } = useAlerts();

  const handleAlertTriggered = useCallback(
    (msg: AlertTriggeredMessage) => {
      updateAlert(msg.alertId, { lastTriggeredAt: msg.triggeredAt });
    },
    [updateAlert],
  );

  const {
    fearGreed: wsFearGreed,
    vix: wsVix,
    btc: wsBtc,
    spx: wsSpx,
    wsStatus,
    lastFearGreedUpdate,
    lastVixUpdate,
    lastBtcUpdate,
    lastSpxUpdate,
  } = useMarketIndicators({ alerts, onAlertTriggered: handleAlertTriggered });

  const { data: httpFearGreed, isLoading: fgLoading, isFetching: fgFetching, refetch: refetchFg } = useFearGreed();
  const { data: httpVix, isLoading: vixLoading, isFetching: vixFetching, refetch: refetchVix } = useVix();
  const { data: httpBtc, isLoading: btcLoading, isFetching: btcFetching } = useBtc();
  const { data: httpSpx, isLoading: spxLoading, isFetching: spxFetching } = useSpx();

  const lastGoodFearGreedRef = useRef<FearGreed | null>(null);
  const lastGoodVixRef = useRef<TickerQuote | null>(null);
  const lastGoodBtcRef = useRef<TickerQuote | null>(null);
  const lastGoodSpxRef = useRef<TickerQuote | null>(null);

  const currentFearGreedData = wsFearGreed ?? httpFearGreed ?? null;
  const currentVixData = wsVix ?? httpVix ?? null;
  const currentBtcData = wsBtc ?? httpBtc ?? null;
  const currentSpxData = wsSpx ?? httpSpx ?? null;

  useEffect(() => {
    if (currentFearGreedData) lastGoodFearGreedRef.current = currentFearGreedData;
  }, [currentFearGreedData]);

  useEffect(() => {
    if (currentVixData) lastGoodVixRef.current = currentVixData;
  }, [currentVixData]);

  useEffect(() => {
    if (currentBtcData) lastGoodBtcRef.current = currentBtcData;
  }, [currentBtcData]);

  useEffect(() => {
    if (currentSpxData) lastGoodSpxRef.current = currentSpxData;
  }, [currentSpxData]);

  const fearGreedData = currentFearGreedData ?? (fgFetching ? lastGoodFearGreedRef.current : null);
  const vixData = currentVixData ?? (vixFetching ? lastGoodVixRef.current : null);
  const btcData = currentBtcData ?? (btcFetching ? lastGoodBtcRef.current : null);
  const spxData = currentSpxData ?? (spxFetching ? lastGoodSpxRef.current : null);

  const { theme, setTheme, isDark } = useTheme();
  useTickerSync();
  usePreferencesSync();
  const { order, isInitialLoading, reorder, addTicker, removeTicker, tickers } = useUnifiedOrder();
  // URL-bound pagination. `order` during loading is padded to 36 slots, but
  // the indicator stays mounted with a single placeholder dot so the page
  // footer does not jump when hydration completes.
  const { page, setPage, pageCount } = usePagination(order.length, { perPage: CARDS_PER_PAGE });
  const indicatorPage = isInitialLoading ? 1 : page;
  const indicatorPageCount = isInitialLoading ? 1 : pageCount;
  const [alertsOpen, setAlertsOpen] = useState(false);
  const isMobile = useIsMobile();
  const isNarrow = useIsNarrow();
  const [editMode, setEditMode] = useState(false);

  // Exiting mobile viewport should always leave edit mode; desktop uses native drag.
  useEffect(() => {
    if (!isMobile && editMode) setEditMode(false);
  }, [isMobile, editMode]);

  const [manualFgUpdateMs, setManualFgUpdateMs] = useState(0);
  const [manualVixUpdateMs, setManualVixUpdateMs] = useState(0);

  // Update browser tab title with live data
  useEffect(() => {
    const fg = fearGreedData?.score;
    const vix = vixData?.price;
    if (fg != null && vix != null) {
      document.title = `F&G: ${fg} | VIX: ${vix.toFixed(1)}`;
    } else if (fg != null) {
      document.title = `F&G: ${fg} | VIX: –`;
    } else {
      document.title = 'Fear & Greed / VIX';
    }
  }, [fearGreedData, vixData]);

  const handleRefreshAll = useCallback(() => {
    Promise.all([
      refetchFg().then(() => setManualFgUpdateMs(Date.now())),
      refetchVix().then(() => setManualVixUpdateMs(Date.now())),
    ]);
  }, [refetchFg, refetchVix]);

  const fgDisplayUpdate = manualFgUpdateMs > (lastFearGreedUpdate?.getTime() ?? 0)
    ? new Date(manualFgUpdateMs)
    : lastFearGreedUpdate;

  const vixDisplayUpdate = manualVixUpdateMs > (lastVixUpdate?.getTime() ?? 0)
    ? new Date(manualVixUpdateMs)
    : lastVixUpdate;

  const btcDisplayUpdate = lastBtcUpdate ?? (btcData?.fetchedAt ? new Date(btcData.fetchedAt) : null);
  const spxDisplayUpdate = lastSpxUpdate ?? (spxData?.fetchedAt ? new Date(spxData.fetchedAt) : null);

  const activeAlertCount = alerts.filter(a => a.enabled).length;

  return (
    <div className={`app-container ${isMobile ? 'app-container-mobile' : ''} ${isDark ? 'app-dark' : 'app-light'}`}>
      <div className="widget">
        <div className="top-bar">
          <AddTickerInput
            tickerCount={tickers.length}
            isDark={isDark}
            onAdd={addTicker}
            collapsible={isNarrow}
          />
          <IconBar
            isDark={isDark}
            wsStatus={wsStatus}
            onStatusClick={handleRefreshAll}
            activeAlertCount={activeAlertCount}
            onAlertsClick={() => setAlertsOpen(v => !v)}
            theme={theme}
            onThemeSelect={setTheme}
          />
          {isMobile && !isInitialLoading && (
            editMode ? (
              <button
                type="button"
                className="edit-toggle edit-toggle-done"
                onClick={() => setEditMode(false)}
                aria-label="Finish reordering"
              >
                Done
              </button>
            ) : (
              <button
                type="button"
                className={`icon-btn edit-toggle ${isDark ? 'icon-btn-dark' : 'icon-btn-light'}`}
                onClick={() => setEditMode(true)}
                aria-label="Edit order"
                aria-pressed={editMode}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke={isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)'}
                  strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
                  aria-hidden="true">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
              </button>
            )
          )}
        </div>
        {alertsOpen && (
          <AlertsPopup
            isDark={isDark}
            alerts={alerts}
            onAdd={addAlert}
            onUpdate={updateAlert}
            onDelete={deleteAlert}
            onToggle={toggleAlert}
            onClose={() => setAlertsOpen(false)}
            isAnonymous={alertsAnonymous}
            migrationCandidate={alertsMigrationCandidate}
            onAcceptMigration={() => { void acceptAlertsMigration(); }}
            onDismissMigration={dismissAlertsMigration}
          />
        )}
        {isMobile ? (
          <MobileMetricList
            order={order}
            onReorder={reorder}
            page={page}
            perPage={CARDS_PER_PAGE}
            onPageChange={setPage}
            pageCount={pageCount}
            onRemoveTicker={removeTicker}
            isDark={isDark}
            editMode={editMode}
            isInitialLoading={isInitialLoading}
            fearGreedData={fearGreedData}
            fgIsLoading={fgLoading && !wsFearGreed && !httpFearGreed}
            fgIsRefreshing={fgFetching}
            vixData={vixData}
            vixIsLoading={vixLoading && !wsVix && !httpVix}
            vixIsRefreshing={vixFetching}
            btcData={btcData}
            btcIsLoading={btcLoading && !wsBtc && !httpBtc}
            btcIsRefreshing={btcFetching}
            spxData={spxData}
            spxIsLoading={spxLoading && !wsSpx && !httpSpx}
            spxIsRefreshing={spxFetching}
          />
        ) : (
          <CardGrid
            order={order}
            onReorder={reorder}
            page={page}
            perPage={CARDS_PER_PAGE}
            onRemoveTicker={removeTicker}
            isDark={isDark}
            isInitialLoading={isInitialLoading}
            fearGreedData={fearGreedData}
            fgLastUpdate={fgDisplayUpdate}
            fgIsLoading={fgLoading && !wsFearGreed && !httpFearGreed}
            fgIsRefreshing={fgFetching}
            vixData={vixData}
            vixLastUpdate={vixDisplayUpdate}
            vixIsLoading={vixLoading && !wsVix && !httpVix}
            vixIsRefreshing={vixFetching}
            btcData={btcData}
            btcLastUpdate={btcDisplayUpdate}
            btcIsLoading={btcLoading && !wsBtc && !httpBtc}
            btcIsRefreshing={btcFetching}
            spxData={spxData}
            spxLastUpdate={spxDisplayUpdate}
            spxIsLoading={spxLoading && !wsSpx && !httpSpx}
            spxIsRefreshing={spxFetching}
          />
        )}
        {indicatorPageCount >= 1 && (
          <PageIndicator
            page={indicatorPage}
            pageCount={indicatorPageCount}
            onPageChange={setPage}
            isDark={isDark}
            // Mobile relies on swipe for navigation; show dots only.
            showChevrons={!isMobile}
          />
        )}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <MarketIndicators />
    </QueryClientProvider>
  );
}
