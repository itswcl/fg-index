export type WebhookType = 'discord' | 'slack' | 'telegram';

export interface WebhookConfig {
  type: WebhookType;
  url?: string;        // discord, slack: the webhook URL
  botToken?: string;   // telegram: bot token from @BotFather
  chatId?: string;     // telegram: chat/channel ID
}

export interface Condition {
  metric: 'fearGreed' | 'vix' | 'btc' | 'spx';
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
