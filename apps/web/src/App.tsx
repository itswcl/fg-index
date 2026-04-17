import { useCallback, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
import { useWebhook } from './hooks/useWebhook';
import { CardGrid } from './components/CardGrid';
import { MobileMetricList } from './components/MobileMetricList';
import { IconBar } from './components/IconBar';
import { AlertsPopup } from './components/AlertsPopup';
import { AddTickerInput } from './components/AddTickerInput';
import { useIsMobile, useIsNarrow } from './hooks/useIsMobile';
import type { AlertTriggeredMessage } from './types/alerts';
import './App.css';

const queryClient = new QueryClient();

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
  const { webhook, setWebhook, clearWebhook } = useWebhook();

  const handleAlertTriggered = useCallback(
    (msg: AlertTriggeredMessage) => {
      updateAlert(msg.alertId, { lastTriggeredAt: msg.triggeredAt });
    },
    [updateAlert],
  );

  const {
    fearGreed: wsFearGreed,
    vix: wsVix,
    vixAvailable,
    btc: wsBtc,
    spx: wsSpx,
    spxAvailable,
    wsStatus,
    lastFearGreedUpdate,
    lastVixUpdate,
    lastBtcUpdate,
    lastSpxUpdate,
  } = useMarketIndicators({ alerts, onAlertTriggered: handleAlertTriggered, webhook });

  const { data: httpFearGreed, isLoading: fgLoading, isFetching: fgFetching, refetch: refetchFg } = useFearGreed();
  const { data: httpVix, isLoading: vixLoading, isFetching: vixFetching, refetch: refetchVix } = useVix();
  const { data: httpBtc, isLoading: btcLoading, isFetching: btcFetching } = useBtc();
  const { data: httpSpx, isLoading: spxLoading, isFetching: spxFetching } = useSpx();

  const fearGreedData = wsFearGreed ?? httpFearGreed ?? null;
  const vixData = wsVix ?? httpVix ?? null;
  const btcData = wsBtc ?? httpBtc ?? null;
  const spxData = wsSpx ?? httpSpx ?? null;

  const { theme, setTheme, isDark } = useTheme();
  useTickerSync();
  usePreferencesSync();
  const { order, reorder, addTicker, removeTicker, tickers } = useUnifiedOrder();
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
          {isMobile && (
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
            webhook={webhook}
            onSaveWebhook={setWebhook}
            onRemoveWebhook={clearWebhook}
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
            onRemoveTicker={removeTicker}
            isDark={isDark}
            editMode={editMode}
            fearGreedData={fearGreedData}
            fgIsLoading={fgLoading && !wsFearGreed && !httpFearGreed}
            fgIsRefreshing={fgFetching}
            vixData={vixData}
            vixAvailable={vixAvailable}
            vixIsLoading={vixLoading && !wsVix && !httpVix}
            vixIsRefreshing={vixFetching}
            btcData={btcData}
            btcIsLoading={btcLoading && !wsBtc && !httpBtc}
            btcIsRefreshing={btcFetching}
            spxData={spxData}
            spxAvailable={spxAvailable}
            spxIsLoading={spxLoading && !wsSpx && !httpSpx}
            spxIsRefreshing={spxFetching}
          />
        ) : (
          <CardGrid
            order={order}
            onReorder={reorder}
            onRemoveTicker={removeTicker}
            isDark={isDark}
            fearGreedData={fearGreedData}
            fgLastUpdate={fgDisplayUpdate}
            fgIsLoading={fgLoading && !wsFearGreed && !httpFearGreed}
            fgIsRefreshing={fgFetching}
            vixData={vixData}
            vixAvailable={vixAvailable}
            vixLastUpdate={vixDisplayUpdate}
            vixIsLoading={vixLoading && !wsVix && !httpVix}
            vixIsRefreshing={vixFetching}
            btcData={btcData}
            btcLastUpdate={btcDisplayUpdate}
            btcIsLoading={btcLoading && !wsBtc && !httpBtc}
            btcIsRefreshing={btcFetching}
            spxData={spxData}
            spxAvailable={spxAvailable}
            spxLastUpdate={spxDisplayUpdate}
            spxIsLoading={spxLoading && !wsSpx && !httpSpx}
            spxIsRefreshing={spxFetching}
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
