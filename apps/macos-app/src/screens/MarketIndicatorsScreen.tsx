import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
} from 'react-native';
import { useMarketIndicators } from '../hooks/useMarketIndicators';
import { useFearGreed } from '../hooks/useFearGreed';
import { useVix } from '../hooks/useVix';
import { FearGreedCard } from '../components/FearGreedCard';
import { VixCard } from '../components/VixCard';
import { StatusRefreshButton } from '../components/StatusRefreshButton';
import { useAppColorScheme } from '../hooks/useAppColorScheme';

export function MarketIndicatorsScreen() {
  const {
    fearGreed: wsFearGreed,
    vix: wsVix,
    vixAvailable,
    wsStatus,
    lastFearGreedUpdate,
    lastVixUpdate,
  } = useMarketIndicators();

  // HTTP fallbacks
  const { data: httpFearGreed, isLoading: fgLoading, isFetching: fgFetching, refetch: refetchFg } = useFearGreed();
  const { data: httpVix, isLoading: vixLoading, isFetching: vixFetching, refetch: refetchVix } = useVix();

  const fearGreedData = wsFearGreed ?? httpFearGreed ?? null;
  const vixData = wsVix ?? httpVix ?? null;

  const colorScheme = useAppColorScheme();
  const isLight = colorScheme === 'light';

  const [manualFgUpdateMs, setManualFgUpdateMs] = useState<number>(0);
  const [manualVixUpdateMs, setManualVixUpdateMs] = useState<number>(0);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);

  const handleRefreshAll = useCallback(() => {
    setIsManualRefreshing(true);
    
    // Minimum visual feedback duration (800ms)
    const minDelay = new Promise(resolve => setTimeout(resolve, 800));
    
    Promise.all([
      refetchFg().then(() => setManualFgUpdateMs(Date.now())),
      refetchVix().then(() => setManualVixUpdateMs(Date.now())),
      minDelay
    ]).finally(() => {
      setIsManualRefreshing(false);
    });
  }, [refetchFg, refetchVix]);

  const fgDisplayUpdate = manualFgUpdateMs > (lastFearGreedUpdate?.getTime() || 0)
    ? new Date(manualFgUpdateMs)
    : lastFearGreedUpdate;

  const vixDisplayUpdate = manualVixUpdateMs > (lastVixUpdate?.getTime() || 0)
    ? new Date(manualVixUpdateMs)
    : lastVixUpdate;

  const isRefreshing = fgFetching || vixFetching || isManualRefreshing;

  return (
    <View style={[styles.container, isLight && styles.containerLight]}>
      <View style={styles.cardsRow}>
        <FearGreedCard
          data={fearGreedData}
          lastUpdate={fgDisplayUpdate}
          isLoading={fgLoading && !wsFearGreed && !httpFearGreed}
          isRefreshing={fgFetching}
        />
        <VixCard
          data={vixData}
          vixAvailable={vixAvailable}
          lastUpdate={vixDisplayUpdate}
          isLoading={vixLoading && !wsVix && !httpVix}
          isRefreshing={vixFetching}
        />
      </View>
      <View style={styles.bottomStatusArea}>
        <StatusRefreshButton
          status={wsStatus}
          onPress={handleRefreshAll}
          isRefreshing={isRefreshing}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 44, 
  },
  containerLight: {
    backgroundColor: '#F2F2F7',
  },
  bottomStatusArea: {
    position: 'absolute',
    bottom: 10,
    left: 14,
    right: 14,
    alignItems: 'center',
    zIndex: 100,
  },
  cardsRow: {
    flexDirection: 'row',
    flex: 1,
    gap: 12,
  },
});
