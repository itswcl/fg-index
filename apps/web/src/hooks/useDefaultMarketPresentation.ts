import { useCallback, useEffect } from 'react';
import { useBtc } from './useBtc';
import { useFearGreed } from './useFearGreed';
import { useMarketIndicators } from './useMarketIndicators';
import { useSpx } from './useSpx';
import { useVix } from './useVix';
import { useDefaultMarketPresentationStore } from '../stores/useDefaultMarketPresentationStore';
import type { FearGreed, TickerQuote } from '../types';
import type { Alert, AlertTriggeredMessage } from '../types/alerts';
import type { WsStatus } from './useMarketIndicators';

export interface DefaultMarketPresentation {
  wsStatus: WsStatus;
  fearGreedData: FearGreed | null;
  vixData: TickerQuote | null;
  btcData: TickerQuote | null;
  spxData: TickerQuote | null;
  fgLastUpdate: Date | null;
  vixLastUpdate: Date | null;
  btcLastUpdate: Date | null;
  spxLastUpdate: Date | null;
  fgIsLoading: boolean;
  fgIsRefreshing: boolean;
  vixIsLoading: boolean;
  vixIsRefreshing: boolean;
  btcIsLoading: boolean;
  btcIsRefreshing: boolean;
  spxIsLoading: boolean;
  spxIsRefreshing: boolean;
  refreshDefaultIndicators: () => void;
}

export function useDefaultMarketPresentation({
  alerts,
  onAlertTriggered,
}: {
  alerts?: Alert[];
  onAlertTriggered?: (msg: AlertTriggeredMessage) => void;
}): DefaultMarketPresentation {
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
  } = useMarketIndicators({ alerts, onAlertTriggered });

  const { data: httpFearGreed, isLoading: fgLoading, isFetching: fgFetching, refetch: refetchFg } = useFearGreed();
  const { data: httpVix, isLoading: vixLoading, isFetching: vixFetching, refetch: refetchVix } = useVix();
  const { data: httpBtc, isLoading: btcLoading, isFetching: btcFetching } = useBtc();
  const { data: httpSpx, isLoading: spxLoading, isFetching: spxFetching } = useSpx();

  const lastGoodFearGreed = useDefaultMarketPresentationStore((state) => state.lastGoodFearGreed);
  const lastGoodVix = useDefaultMarketPresentationStore((state) => state.lastGoodVix);
  const lastGoodBtc = useDefaultMarketPresentationStore((state) => state.lastGoodBtc);
  const lastGoodSpx = useDefaultMarketPresentationStore((state) => state.lastGoodSpx);
  const manualFgUpdateMs = useDefaultMarketPresentationStore((state) => state.manualFgUpdateMs);
  const manualVixUpdateMs = useDefaultMarketPresentationStore((state) => state.manualVixUpdateMs);
  const rememberFearGreed = useDefaultMarketPresentationStore((state) => state.rememberFearGreed);
  const rememberVix = useDefaultMarketPresentationStore((state) => state.rememberVix);
  const rememberBtc = useDefaultMarketPresentationStore((state) => state.rememberBtc);
  const rememberSpx = useDefaultMarketPresentationStore((state) => state.rememberSpx);
  const markManualFgUpdate = useDefaultMarketPresentationStore((state) => state.markManualFgUpdate);
  const markManualVixUpdate = useDefaultMarketPresentationStore((state) => state.markManualVixUpdate);

  const currentFearGreedData = wsFearGreed ?? httpFearGreed ?? null;
  const currentVixData = wsVix ?? httpVix ?? null;
  const currentBtcData = wsBtc ?? httpBtc ?? null;
  const currentSpxData = wsSpx ?? httpSpx ?? null;

  useEffect(() => {
    if (currentFearGreedData) rememberFearGreed(currentFearGreedData);
  }, [currentFearGreedData, rememberFearGreed]);

  useEffect(() => {
    if (currentVixData) rememberVix(currentVixData);
  }, [currentVixData, rememberVix]);

  useEffect(() => {
    if (currentBtcData) rememberBtc(currentBtcData);
  }, [currentBtcData, rememberBtc]);

  useEffect(() => {
    if (currentSpxData) rememberSpx(currentSpxData);
  }, [currentSpxData, rememberSpx]);

  const fearGreedData = currentFearGreedData ?? (fgFetching ? lastGoodFearGreed : null);
  const vixData = currentVixData ?? (vixFetching ? lastGoodVix : null);
  const btcData = currentBtcData ?? (btcFetching ? lastGoodBtc : null);
  const spxData = currentSpxData ?? (spxFetching ? lastGoodSpx : null);

  useEffect(() => {
    const fg = fearGreedData?.score;
    const vix = vixData?.price;
    if (fg != null && vix != null) {
      document.title = `F&G: ${fg} | VIX: ${vix.toFixed(1)}`;
    } else if (fg != null) {
      document.title = `F&G: ${fg} | VIX: \u2013`;
    } else {
      document.title = 'Fear & Greed / VIX';
    }
  }, [fearGreedData, vixData]);

  const refreshDefaultIndicators = useCallback(() => {
    Promise.all([
      refetchFg().then(markManualFgUpdate),
      refetchVix().then(markManualVixUpdate),
    ]);
  }, [markManualFgUpdate, markManualVixUpdate, refetchFg, refetchVix]);

  const fgLastUpdate = manualFgUpdateMs > (lastFearGreedUpdate?.getTime() ?? 0)
    ? new Date(manualFgUpdateMs)
    : lastFearGreedUpdate;

  const vixLastUpdate = manualVixUpdateMs > (lastVixUpdate?.getTime() ?? 0)
    ? new Date(manualVixUpdateMs)
    : lastVixUpdate;

  const btcLastUpdate = lastBtcUpdate ?? (btcData?.fetchedAt ? new Date(btcData.fetchedAt) : null);
  const spxLastUpdate = lastSpxUpdate ?? (spxData?.fetchedAt ? new Date(spxData.fetchedAt) : null);

  return {
    wsStatus,
    fearGreedData,
    vixData,
    btcData,
    spxData,
    fgLastUpdate,
    vixLastUpdate,
    btcLastUpdate,
    spxLastUpdate,
    fgIsLoading: fgLoading && !wsFearGreed && !httpFearGreed,
    fgIsRefreshing: fgFetching,
    vixIsLoading: vixLoading && !wsVix && !httpVix,
    vixIsRefreshing: vixFetching,
    btcIsLoading: btcLoading && !wsBtc && !httpBtc,
    btcIsRefreshing: btcFetching,
    spxIsLoading: spxLoading && !wsSpx && !httpSpx,
    spxIsRefreshing: spxFetching,
    refreshDefaultIndicators,
  };
}
