import { useEffect, useRef, useState, useCallback } from 'react';
import type { FearGreed, Vix, Btc, Spx } from '../types';
import type { Alert, AlertTriggeredMessage, WebhookConfig } from '../types/alerts';
import { WS_URL } from '../constants';
import { buildWsUrl } from '../lib/authFetch';

export type WsStatus = 'connecting' | 'connected' | 'disconnected';

interface WsMarketMessage {
  type: 'FEAR_GREED_UPDATE' | 'VIX_UPDATE' | 'BTC_UPDATE' | 'SPX_UPDATE';
  payload: FearGreed | Vix | Btc | Spx | null;
}

interface UseMarketIndicatorsReturn {
  fearGreed: FearGreed | null;
  vix: Vix | null;
  vixAvailable: boolean;
  btc: Btc | null;
  spx: Spx | null;
  spxAvailable: boolean;
  wsStatus: WsStatus;
  lastFearGreedUpdate: Date | null;
  lastVixUpdate: Date | null;
  lastBtcUpdate: Date | null;
  lastSpxUpdate: Date | null;
}

interface UseMarketIndicatorsOptions {
  alerts?: Alert[];
  onAlertTriggered?: (msg: AlertTriggeredMessage) => void;
  webhook?: WebhookConfig | null;
}

interface MarketPrices {
  fearGreedScore: number | null;
  vixPrice: number | null;
  btcPrice: number | null;
  spxPrice: number | null;
}

const METRIC_LABELS: Record<string, string> = {
  fearGreed: 'F&G',
  vix: 'VIX',
  btc: 'BTC',
  spx: 'SPX',
};

function getMetricValue(metric: string, prices: MarketPrices): number | null {
  switch (metric) {
    case 'fearGreed': return prices.fearGreedScore;
    case 'vix':       return prices.vixPrice;
    case 'btc':       return prices.btcPrice;
    case 'spx':       return prices.spxPrice;
    default:          return null;
  }
}

function evaluateAlertsLocally(
  alerts: Alert[],
  prices: MarketPrices,
  onTriggered: (msg: AlertTriggeredMessage) => void,
) {
  for (const alert of alerts) {
    if (!alert.enabled) continue;

    const results = alert.conditions.map((cond) => {
      const metricValue = getMetricValue(cond.metric, prices);
      if (metricValue === null) return null;

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
          const val = getMetricValue(c.metric, prices);
          if (val === null) return null;
          const label = METRIC_LABELS[c.metric] ?? c.metric;
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
  const [btc, setBtc] = useState<Btc | null>(null);
  const [spx, setSpx] = useState<Spx | null>(null);
  const [spxAvailable, setSpxAvailable] = useState(true);
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting');
  const [lastFearGreedUpdate, setLastFearGreedUpdate] = useState<Date | null>(null);
  const [lastVixUpdate, setLastVixUpdate] = useState<Date | null>(null);
  const [lastBtcUpdate, setLastBtcUpdate] = useState<Date | null>(null);
  const [lastSpxUpdate, setLastSpxUpdate] = useState<Date | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(3000);
  // Keep latest callback/alerts/webhook in refs so the stable `connect` closure can access them
  const onAlertTriggeredRef = useRef(onAlertTriggered);
  const alertsRef = useRef(alerts);
  const webhookRef = useRef(webhook);
  const latestFearGreedScoreRef = useRef<number | null>(null);
  const latestVixPriceRef = useRef<number | null>(null);
  const latestBtcPriceRef = useRef<number | null>(null);
  const latestSpxPriceRef = useRef<number | null>(null);

  useEffect(() => {
    onAlertTriggeredRef.current = onAlertTriggered;
  }, [onAlertTriggered]);

  useEffect(() => {
    alertsRef.current = alerts;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'set_alerts', alerts: alerts ?? [] }));
    }
  }, [alerts]);

  useEffect(() => {
    webhookRef.current = webhook;
    // Send updated config immediately if WS is already open
    if (wsRef.current?.readyState === WebSocket.OPEN && webhook) {
      wsRef.current.send(JSON.stringify({ type: 'set_webhook', webhook }));
    }
  }, [webhook]);

  const connect = useCallback(async () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setWsStatus('connecting');
    // Build URL with JWT (?token=) and/or API key (?apiKey=) — headers aren't
    // supported on the browser WebSocket handshake, so we pass via query params.
    const url = await buildWsUrl(WS_URL);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus('connected');
      reconnectDelayRef.current = 3000; // Reset on success
      // Sync webhook config to backend on connect
      if (webhookRef.current) {
        ws.send(JSON.stringify({ type: 'set_webhook', webhook: webhookRef.current }));
      }
      // Sync alerts so server can fire webhooks server-side
      if (alertsRef.current?.length) {
        ws.send(JSON.stringify({ type: 'set_alerts', alerts: alertsRef.current }));
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
          if (onAlertTriggeredRef.current && alertsRef.current?.length) {
            evaluateAlertsLocally(alertsRef.current, {
              fearGreedScore: fg.score,
              vixPrice: latestVixPriceRef.current,
              btcPrice: latestBtcPriceRef.current,
              spxPrice: latestSpxPriceRef.current,
            }, onAlertTriggeredRef.current);
          }
        }

        if (message.type === 'VIX_UPDATE' && 'payload' in message) {
          const payload = (message as WsMarketMessage).payload as Vix | null;
          setVix(payload);
          setVixAvailable(payload !== null);
          setLastVixUpdate(new Date());
          latestVixPriceRef.current = payload?.price ?? null;
          if (onAlertTriggeredRef.current && alertsRef.current?.length) {
            evaluateAlertsLocally(alertsRef.current, {
              fearGreedScore: latestFearGreedScoreRef.current,
              vixPrice: payload?.price ?? null,
              btcPrice: latestBtcPriceRef.current,
              spxPrice: latestSpxPriceRef.current,
            }, onAlertTriggeredRef.current);
          }
        }

        if (message.type === 'BTC_UPDATE' && 'payload' in message) {
          const payload = (message as WsMarketMessage).payload as Btc | null;
          setBtc(payload);
          setLastBtcUpdate(new Date());
          latestBtcPriceRef.current = payload?.price ?? null;
          if (onAlertTriggeredRef.current && alertsRef.current?.length) {
            evaluateAlertsLocally(alertsRef.current, {
              fearGreedScore: latestFearGreedScoreRef.current,
              vixPrice: latestVixPriceRef.current,
              btcPrice: payload?.price ?? null,
              spxPrice: latestSpxPriceRef.current,
            }, onAlertTriggeredRef.current);
          }
        }

        if (message.type === 'SPX_UPDATE' && 'payload' in message) {
          const payload = (message as WsMarketMessage).payload as Spx | null;
          setSpx(payload);
          setSpxAvailable(payload !== null);
          setLastSpxUpdate(new Date());
          latestSpxPriceRef.current = payload?.price ?? null;
          if (onAlertTriggeredRef.current && alertsRef.current?.length) {
            evaluateAlertsLocally(alertsRef.current, {
              fearGreedScore: latestFearGreedScoreRef.current,
              vixPrice: latestVixPriceRef.current,
              btcPrice: latestBtcPriceRef.current,
              spxPrice: payload?.price ?? null,
            }, onAlertTriggeredRef.current);
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

  return { fearGreed, vix, vixAvailable, btc, spx, spxAvailable, wsStatus, lastFearGreedUpdate, lastVixUpdate, lastBtcUpdate, lastSpxUpdate };
}
