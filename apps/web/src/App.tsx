import { useCallback, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMarketIndicators } from './hooks/useMarketIndicators';
import { useFearGreed } from './hooks/useFearGreed';
import { useVix } from './hooks/useVix';
import { useBtc } from './hooks/useBtc';
import { useSpx } from './hooks/useSpx';
import { useTheme } from './hooks/useTheme';
import { useAlerts } from './hooks/useAlerts';
import { useWebhook } from './hooks/useWebhook';
import { FearGreedCard } from './components/FearGreedCard';
import { VixCard } from './components/VixCard';
import { BtcCard } from './components/BtcCard';
import { SpxCard } from './components/SpxCard';
import { StatusRefreshButton } from './components/StatusRefreshButton';
import { AlertsPanel } from './components/alerts';
import { BuyMeCoffeeButton } from './components/BuyMeCoffeeButton';
import { ThemeSwitcher } from './components/ThemeSwitcher';
import type { AlertTriggeredMessage } from './types/alerts';
import './App.css';

const queryClient = new QueryClient();

function MarketIndicators() {
  const { alerts, addAlert, updateAlert, deleteAlert, toggleAlert } = useAlerts();
  const { webhook, setWebhook, clearWebhook } = useWebhook();

  const handleAlertTriggered = useCallback(
    (msg: AlertTriggeredMessage) => {
      // Update lastTriggeredAt for the matching alert; backend handles webhook delivery
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

  const [manualFgUpdateMs, setManualFgUpdateMs] = useState(0);
  const [manualVixUpdateMs, setManualVixUpdateMs] = useState(0);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);

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
    setIsManualRefreshing(true);
    const minDelay = new Promise<void>(resolve => setTimeout(resolve, 800));
    Promise.all([
      refetchFg().then(() => setManualFgUpdateMs(Date.now())),
      refetchVix().then(() => setManualVixUpdateMs(Date.now())),
      minDelay,
    ]).finally(() => setIsManualRefreshing(false));
  }, [refetchFg, refetchVix]);

  const fgDisplayUpdate = manualFgUpdateMs > (lastFearGreedUpdate?.getTime() ?? 0)
    ? new Date(manualFgUpdateMs)
    : lastFearGreedUpdate;

  const vixDisplayUpdate = manualVixUpdateMs > (lastVixUpdate?.getTime() ?? 0)
    ? new Date(manualVixUpdateMs)
    : lastVixUpdate;

  const btcDisplayUpdate = lastBtcUpdate ?? (btcData?.fetchedAt ? new Date(btcData.fetchedAt) : null);
  const spxDisplayUpdate = lastSpxUpdate ?? (spxData?.fetchedAt ? new Date(spxData.fetchedAt) : null);

  const isRefreshing = fgFetching || vixFetching || isManualRefreshing;

  return (
    <div className={`app-container ${isDark ? 'app-dark' : 'app-light'}`}>
      <div className="widget">
        <div className="theme-switcher-row">
          <ThemeSwitcher theme={theme} onSelect={setTheme} isDark={isDark} />
        </div>
        <div className="cards-grid">
          <FearGreedCard
            data={fearGreedData}
            lastUpdate={fgDisplayUpdate}
            isLoading={fgLoading && !wsFearGreed && !httpFearGreed}
            isRefreshing={fgFetching}
            isDark={isDark}
          />
          <VixCard
            data={vixData}
            vixAvailable={vixAvailable}
            lastUpdate={vixDisplayUpdate}
            isLoading={vixLoading && !wsVix && !httpVix}
            isRefreshing={vixFetching}
            isDark={isDark}
          />
          <BtcCard
            data={btcData}
            lastUpdate={btcDisplayUpdate}
            isLoading={btcLoading && !wsBtc && !httpBtc}
            isRefreshing={btcFetching}
            isDark={isDark}
          />
          <SpxCard
            data={spxData}
            spxAvailable={spxAvailable}
            lastUpdate={spxDisplayUpdate}
            isLoading={spxLoading && !wsSpx && !httpSpx}
            isRefreshing={spxFetching}
            isDark={isDark}
          />
        </div>
        <div className="status-area">
          <StatusRefreshButton
            status={wsStatus}
            onPress={handleRefreshAll}
            isRefreshing={isRefreshing}
            isDark={isDark}
          />
        </div>
        <AlertsPanel
          alerts={alerts}
          onAdd={addAlert}
          onUpdate={updateAlert}
          onDelete={deleteAlert}
          onToggle={toggleAlert}
          webhook={webhook}
          onSaveWebhook={setWebhook}
          onRemoveWebhook={clearWebhook}
          isDark={isDark}
        />
        <BuyMeCoffeeButton isDark={isDark} />
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
