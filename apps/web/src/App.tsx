import { useCallback, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMarketIndicators } from './hooks/useMarketIndicators';
import { useFearGreed } from './hooks/useFearGreed';
import { useVix } from './hooks/useVix';
import { useBtc } from './hooks/useBtc';
import { useSpx } from './hooks/useSpx';
import { useTheme } from './hooks/useTheme';
import { useCardOrder } from './hooks/useCardOrder';
import { useAlerts } from './hooks/useAlerts';
import { useWebhook } from './hooks/useWebhook';
import { CardGrid } from './components/CardGrid';
import { IconBar } from './components/IconBar';
import { AlertsPopup } from './components/AlertsPopup';
import type { AlertTriggeredMessage } from './types/alerts';
import './App.css';

const queryClient = new QueryClient();

function MarketIndicators() {
  const { alerts, addAlert, updateAlert, deleteAlert, toggleAlert } = useAlerts();
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
  const { order, setOrder } = useCardOrder();
  const [alertsOpen, setAlertsOpen] = useState(false);

  const [manualFgUpdateMs, setManualFgUpdateMs] = useState(0);
  const [manualVixUpdateMs, setManualVixUpdateMs] = useState(0);

  // Update browser tab title with live data
  useEffect(() => {
    const fg = fearGreedData?.score;
    const vix = vixData?.price;
    if (fg !== undefined && vix !== undefined) {
      document.title = `F&G: ${fg} | VIX: ${vix.toFixed(1)}`;
    } else if (fg !== undefined) {
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
    <div className={`app-container ${isDark ? 'app-dark' : 'app-light'}`}>
      <div className="widget">
        <IconBar
          isDark={isDark}
          wsStatus={wsStatus}
          onStatusClick={handleRefreshAll}
          activeAlertCount={activeAlertCount}
          onAlertsClick={() => setAlertsOpen(v => !v)}
          theme={theme}
          onThemeSelect={setTheme}
        />
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
          />
        )}
        <CardGrid
          order={order}
          onReorder={setOrder}
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
