import { useEffect, useRef, useState, useCallback } from 'react';
import type { FearGreed, Vix } from '../types';
import { WS_URL, API_KEY } from '../constants';

export type WsStatus = 'connecting' | 'connected' | 'disconnected';

interface WsMessage {
  type: 'FEAR_GREED_UPDATE' | 'VIX_UPDATE';
  payload: FearGreed | Vix | null;
}

interface UseMarketIndicatorsReturn {
  fearGreed: FearGreed | null;
  vix: Vix | null;
  vixAvailable: boolean;
  wsStatus: WsStatus;
  lastFearGreedUpdate: Date | null;
  lastVixUpdate: Date | null;
}

export function useMarketIndicators(): UseMarketIndicatorsReturn {
  const [fearGreed, setFearGreed] = useState<FearGreed | null>(null);
  const [vix, setVix] = useState<Vix | null>(null);
  const [vixAvailable, setVixAvailable] = useState(true);
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting');
  const [lastFearGreedUpdate, setLastFearGreedUpdate] = useState<Date | null>(null);
  const [lastVixUpdate, setLastVixUpdate] = useState<Date | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(3000);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setWsStatus('connecting');
    // Append API key as query param for WS auth (headers not supported in browser WS)
    const url = API_KEY ? `${WS_URL}?apiKey=${encodeURIComponent(API_KEY)}` : WS_URL;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus('connected');
      reconnectDelayRef.current = 3000; // Reset on success
    };

    ws.onmessage = (event) => {
      try {
        const message: WsMessage = JSON.parse(event.data as string);

        if (message.type === 'FEAR_GREED_UPDATE' && message.payload) {
          setFearGreed(message.payload as FearGreed);
          setLastFearGreedUpdate(new Date());
        }

        if (message.type === 'VIX_UPDATE') {
          const payload = message.payload as Vix | null;
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
      // Exponential backoff, capped at 60s (covers Render's ~30-50s cold start)
      const delay = Math.min(reconnectDelayRef.current, 60000);
      reconnectDelayRef.current = Math.min(delay * 1.5, 60000);
      reconnectTimerRef.current = setTimeout(connect, delay);
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
