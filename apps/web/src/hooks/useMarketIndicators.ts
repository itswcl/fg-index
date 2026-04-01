import { useEffect, useRef, useState, useCallback } from 'react';
import type { FearGreed, Vix } from '../types';
import type { Alert, AlertTriggeredMessage, WebhookConfig } from '../types/alerts';
import { WS_URL, API_KEY } from '../constants';

export type WsStatus = 'connecting' | 'connected' | 'disconnected';

interface WsMarketMessage {
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

interface UseMarketIndicatorsOptions {
  alerts?: Alert[];
  onAlertTriggered?: (msg: AlertTriggeredMessage) => void;
  webhook?: WebhookConfig | null;
}

function evaluateAlertsLocally(
  alerts: Alert[],
  fearGreedScore: number | null,
  vixPrice: number | null,
  onTriggered: (msg: AlertTriggeredMessage) => void,
) {
  for (const alert of alerts) {
    if (!alert.enabled) continue;

    const results = alert.conditions.map((cond) => {
      const metricValue = cond.metric === 'fearGreed' ? fearGreedScore : vixPrice;
      if (metricValue === null) return null; // skip if data unavailable

      switch (cond.operator) {
        case '<':  return metricValue < cond.value;
        case '>':  return metricValue > cond.value;
        case '<=': return metricValue <= cond.value;
        case '>=': return metricValue >= cond.value;
        case '==': return metricValue === cond.value;
        default:   return false;
      }
    });

    const definedResults = results.filter((r): r is boolean => r !== null);
    if (definedResults.length === 0) continue;

    const triggered =
      alert.logic === 'AND'
        ? definedResults.every(Boolean)
        : definedResults.some(Boolean);

    if (triggered) {
      const parts = alert.conditions
        .map((c) => {
          const val = c.metric === 'fearGreed' ? fearGreedScore : vixPrice;
          if (val === null) return null;
          const label = c.metric === 'fearGreed' ? 'F&G' : 'VIX';
          return `${label} is ${val} (${c.operator} ${c.value})`;
        })
        .filter(Boolean);
      const message = parts.join(` ${alert.logic} `);

      onTriggered({
        type: 'alert_triggered',
        alertId: alert.id,
        alertName: alert.name,
        message,
        triggeredAt: new Date().toISOString(),
      });
    }
  }
}

export function useMarketIndicators(
  options: UseMarketIndicatorsOptions = {},
): UseMarketIndicatorsReturn {
  const { alerts, onAlertTriggered, webhook } = options;

  const [fearGreed, setFearGreed] = useState<FearGreed | null>(null);
  const [vix, setVix] = useState<Vix | null>(null);
  const [vixAvailable, setVixAvailable] = useState(true);
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting');
  const [lastFearGreedUpdate, setLastFearGreedUpdate] = useState<Date | null>(null);
  const [lastVixUpdate, setLastVixUpdate] = useState<Date | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(3000);
  // Keep latest callback/alerts/webhook in refs so the stable `connect` closure can access them
  const onAlertTriggeredRef = useRef(onAlertTriggered);
  const alertsRef = useRef(alerts);
  const webhookRef = useRef(webhook);
  const latestFearGreedScoreRef = useRef<number | null>(null);
  const latestVixPriceRef = useRef<number | null>(null);

  useEffect(() => {
    onAlertTriggeredRef.current = onAlertTriggered;
  }, [onAlertTriggered]);

  useEffect(() => {
    alertsRef.current = alerts;
  }, [alerts]);

  useEffect(() => {
    webhookRef.current = webhook;
    // Send updated config immediately if WS is already open
    if (wsRef.current?.readyState === WebSocket.OPEN && webhook) {
      wsRef.current.send(JSON.stringify({ type: 'set_webhook', webhook }));
    }
  }, [webhook]);

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
      // Sync webhook config to backend on connect
      if (webhookRef.current) {
        ws.send(JSON.stringify({ type: 'set_webhook', webhook: webhookRef.current }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as WsMarketMessage | AlertTriggeredMessage;

        if (message.type === 'FEAR_GREED_UPDATE' && 'payload' in message && message.payload) {
          const fg = message.payload as FearGreed;
          setFearGreed(fg);
          setLastFearGreedUpdate(new Date());
          latestFearGreedScoreRef.current = fg.score;
          // evaluate alerts with latest values
          if (onAlertTriggeredRef.current && alertsRef.current?.length) {
            evaluateAlertsLocally(
              alertsRef.current,
              fg.score,
              latestVixPriceRef.current,
              onAlertTriggeredRef.current,
            );
          }
        }

        if (message.type === 'VIX_UPDATE' && 'payload' in message) {
          const payload = (message as WsMarketMessage).payload as Vix | null;
          setVix(payload);
          setVixAvailable(payload !== null);
          setLastVixUpdate(new Date());
          latestVixPriceRef.current = payload?.price ?? null;
          // evaluate alerts with latest values
          if (onAlertTriggeredRef.current && alertsRef.current?.length) {
            evaluateAlertsLocally(
              alertsRef.current,
              latestFearGreedScoreRef.current,
              payload?.price ?? null,
              onAlertTriggeredRef.current,
            );
          }
        }

        // keep alert_triggered handler in case backend adds it later
        if (message.type === 'alert_triggered') {
          onAlertTriggeredRef.current?.(message as AlertTriggeredMessage);
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
