import { useEffect, useRef, useState, useCallback } from 'react';
import type { FearGreed, TickerQuote } from '../types';
import type { Alert, AlertTriggeredMessage } from '../types/alerts';
import { WS_URL } from '../constants';
import { buildWsUrl } from '../lib/authFetch';

export type WsStatus = 'connecting' | 'connected' | 'disconnected';

interface WsMarketMessage {
  type: 'FEAR_GREED_UPDATE' | 'VIX_UPDATE' | 'BTC_UPDATE' | 'SPX_UPDATE';
  payload: FearGreed | TickerQuote | null;
}

interface UseMarketIndicatorsReturn {
  fearGreed: FearGreed | null;
  vix: TickerQuote | null;
  vixAvailable: boolean;
  btc: TickerQuote | null;
  spx: TickerQuote | null;
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
  const { alerts, onAlertTriggered } = options;

  const [fearGreed, setFearGreed] = useState<FearGreed | null>(null);
  const [vix, setVix] = useState<TickerQuote | null>(null);
  const [vixAvailable, setVixAvailable] = useState(true);
  const [btc, setBtc] = useState<TickerQuote | null>(null);
  const [spx, setSpx] = useState<TickerQuote | null>(null);
  const [spxAvailable, setSpxAvailable] = useState(true);
  // Initial mount shows the yellow pulse ("loading") until the first
  // successful WS handshake. After that, we never go back to yellow —
  // transient reconnects stay green (silent) until the 15s disconnect
  // timer promotes us to red. Prevents the yellow↔green flashing users
  // saw on every brief Render socket drop.
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting');
  const [lastFearGreedUpdate, setLastFearGreedUpdate] = useState<Date | null>(null);
  const [lastVixUpdate, setLastVixUpdate] = useState<Date | null>(null);
  const [lastBtcUpdate, setLastBtcUpdate] = useState<Date | null>(null);
  const [lastSpxUpdate, setLastSpxUpdate] = useState<Date | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(3000);
  // Flips true on the first successful WS handshake. Once true, the
  // status dot never reverts to 'connecting' — only green or red —
  // so brief reconnect cycles don't cause a visible flash.
  const hasConnectedOnceRef = useRef(false);
  // Keep latest callback/alerts in refs so the stable `connect` closure can access them
  const onAlertTriggeredRef = useRef(onAlertTriggered);
  const alertsRef = useRef(alerts);
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

  const connect = useCallback(async () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    // Build URL with JWT (?token=) and/or API key (?apiKey=) — headers aren't
    // supported on the browser WebSocket handshake, so we pass via query params.
    const url = await buildWsUrl(WS_URL);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus('connected');
      hasConnectedOnceRef.current = true;
      reconnectDelayRef.current = 3000; // Reset on success
      if (disconnectTimerRef.current) {
        clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      }
      // Sync alerts so the server can fire webhooks against the user's
      // server-side webhook list (BE now reads from its own DB — FE no
      // longer pushes webhook config over the socket).
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
          const payload = (message as WsMarketMessage).payload as TickerQuote | null;
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
          const payload = (message as WsMarketMessage).payload as TickerQuote | null;
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
          const payload = (message as WsMarketMessage).payload as TickerQuote | null;
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

    // Before the first successful handshake, show yellow ("connecting")
    // so users see a real loading indicator. After we've connected at
    // least once, stay silent (green) through transient drops — only
    // promote to red if the outage lasts SUSTAINED_MS. This eliminates
    // the yellow↔green flashing on every brief Render socket drop.
    const SUSTAINED_MS = 15_000;
    const markReconnecting = () => {
      if (!hasConnectedOnceRef.current) {
        setWsStatus('connecting');
      }
      if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = setTimeout(() => {
        setWsStatus('disconnected');
      }, SUSTAINED_MS);
    };

    ws.onerror = () => {
      markReconnecting();
    };

    ws.onclose = () => {
      markReconnecting();
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
      disconnectTimerRef.current && clearTimeout(disconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { fearGreed, vix, vixAvailable, btc, spx, spxAvailable, wsStatus, lastFearGreedUpdate, lastVixUpdate, lastBtcUpdate, lastSpxUpdate };
}
