export type FearGreedClassification = 'Extreme Fear' | 'Fear' | 'Neutral' | 'Greed' | 'Extreme Greed';

export interface FearGreed {
  score: number;
  classification: FearGreedClassification;
  previousClose: number;
  oneWeekAgo: number;
  oneMonthAgo: number;
  oneYearAgo: number;
  updatedAt: string;
  /** Public URL of the source page (CNN Fear & Greed). */
  sourceUrl?: string;
}

export interface TickerQuote {
  ticker: string;
  name?: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  fetchedAt: string;
  /** Public URL of the source page the price was scraped from. */
  sourceUrl?: string;
}
