export interface Condition {
  metric: 'fearGreed' | 'vix';
  operator: '<' | '>' | '<=' | '>=' | '==';
  value: number;
}

export interface Alert {
  id: string;
  name: string;
  conditions: Condition[];
  logic: 'AND' | 'OR';
  enabled: boolean;
  createdAt: string;
  lastTriggeredAt?: string;
}

// WS message types
export interface SetAlertsMessage {
  type: 'set_alerts';
  alerts: Alert[];
}

export interface AlertTriggeredMessage {
  type: 'alert_triggered';
  alertId: string;
  alertName: string;
  message: string;
  triggeredAt: string;
}
