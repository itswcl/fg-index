import React, { useCallback, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMarketIndicators } from './hooks/useMarketIndicators';
import { useFearGreed } from './hooks/useFearGreed';
import { useVix } from './hooks/useVix';
import { useAppColorScheme } from './hooks/useAppColorScheme';
import { FearGreedCard } from './components/FearGreedCard';
import { VixCard } from './components/VixCard';
import { StatusRefreshButton } from './components/StatusRefreshButton';
import './App.css';

const queryClient = new QueryClient();

function MarketIndicators() {
  const {
    fearGreed: wsFearGreed,
    vix: wsVix,
    vixAvailable,
    wsStatus,
    lastFearGreedUpdate,
    lastVixUpdate,
  } = useMarketIndicators();

  const { data: httpFearGreed, isLoading: fgLoading, isFetching: fgFetching, refetch: refetchFg } = useFearGreed();
  const { data: httpVix, isLoading: vixLoading, isFetching: vixFetching, refetch: refetchVix } = useVix();

  const fearGreedData = wsFearGreed ?? httpFearGreed ?? null;
  const vixData = wsVix ?? httpVix ?? null;

  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === 'dark';

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

  const isRefreshing = fgFetching || vixFetching || isManualRefreshing;

  return (
    <div className={`app-container ${isDark ? 'app-dark' : 'app-light'}`}>
      <div className="widget">
        <div className="cards-row">
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
        </div>
        <div className="status-area">
          <StatusRefreshButton
            status={wsStatus}
            onPress={handleRefreshAll}
            isRefreshing={isRefreshing}
            isDark={isDark}
          />
        </div>
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
