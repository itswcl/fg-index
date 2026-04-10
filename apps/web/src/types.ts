export type FearGreedClassification = 'Extreme Fear' | 'Fear' | 'Neutral' | 'Greed' | 'Extreme Greed';

export interface FearGreed {
  score: number;
  classification: FearGreedClassification;
  previousClose: number;
  oneWeekAgo: number;
  oneMonthAgo: number;
  oneYearAgo: number;
  updatedAt: string;
}

export interface Vix {
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  fetchedAt: string;
}

export interface Btc {
  price: number;
  change: number;
  changePercent: number;
  fetchedAt: string;
}

export interface Spx {
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  fetchedAt: string;
}

export interface TickerQuote {
  ticker: string;
  name?: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  fetchedAt: string;
}
