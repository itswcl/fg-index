import { useEffect, useRef, useState, useCallback } from 'react';
import { FearGreed, TickerQuote } from '@shared/types';
import { WS_URL } from '../constants';

export type WsStatus = 'connecting' | 'connected' | 'disconnected';

interface WsMessage {
  type: 'FEAR_GREED_UPDATE' | 'VIX_UPDATE';
  payload: FearGreed | TickerQuote | null;
}

interface UseMarketIndicatorsReturn {
  fearGreed: FearGreed | null;
  vix: TickerQuote | null;
  vixAvailable: boolean;
  wsStatus: WsStatus;
  lastFearGreedUpdate: Date | null;
  lastVixUpdate: Date | null;
}

/**
 * Primary hook — subscribes to the WS stream for both F&G and VIX.
 * Reconnects automatically on disconnect.
 */
export function useMarketIndicators(): UseMarketIndicatorsReturn {
  const [fearGreed, setFearGreed] = useState<FearGreed | null>(null);
  const [vix, setVix] = useState<TickerQuote | null>(null);
  const [vixAvailable, setVixAvailable] = useState(true);
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting');
  const [lastFearGreedUpdate, setLastFearGreedUpdate] = useState<Date | null>(null);
  const [lastVixUpdate, setLastVixUpdate] = useState<Date | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setWsStatus('connecting');
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus('connected');
    };

    ws.onmessage = (event) => {
      try {
        const message: WsMessage = JSON.parse(event.data);

        if (message.type === 'FEAR_GREED_UPDATE' && message.payload) {
          const payload = message.payload as FearGreed;
          setFearGreed(payload);
          setLastFearGreedUpdate(new Date());
        }

        if (message.type === 'VIX_UPDATE') {
          const payload = message.payload as TickerQuote | null;
          setVix(payload);
          setVixAvailable(payload !== null);
          setLastVixUpdate(new Date());
        }
      } catch {
        // Malformed message — ignore
      }
    };

    ws.onerror = () => {
      setWsStatus('disconnected');
    };

    ws.onclose = () => {
      setWsStatus('disconnected');
      // Exponential backoff reconnect — 3s
      reconnectTimerRef.current = setTimeout(connect, 3000);
    };
  }, []);

  useEffect(() => {
    connect();

    return () => {
      reconnectTimerRef.current && clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { fearGreed, vix, vixAvailable, wsStatus, lastFearGreedUpdate, lastVixUpdate };
}
