import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { FearGreed, TickerQuote } from '../types';

export interface DefaultMarketPresentationState {
  lastGoodFearGreed: FearGreed | null;
  lastGoodVix: TickerQuote | null;
  lastGoodBtc: TickerQuote | null;
  lastGoodSpx: TickerQuote | null;
  manualFgUpdateMs: number;
  manualVixUpdateMs: number;
}

export interface DefaultMarketPresentationActions {
  rememberFearGreed: (data: FearGreed) => void;
  rememberVix: (data: TickerQuote) => void;
  rememberBtc: (data: TickerQuote) => void;
  rememberSpx: (data: TickerQuote) => void;
  markManualFgUpdate: () => void;
  markManualVixUpdate: () => void;
}

export type DefaultMarketPresentationStore =
  DefaultMarketPresentationState & DefaultMarketPresentationActions;

export const useDefaultMarketPresentationStore = create<DefaultMarketPresentationStore>()(
  subscribeWithSelector((set) => ({
    lastGoodFearGreed: null,
    lastGoodVix: null,
    lastGoodBtc: null,
    lastGoodSpx: null,
    manualFgUpdateMs: 0,
    manualVixUpdateMs: 0,
    rememberFearGreed: (lastGoodFearGreed) => set({ lastGoodFearGreed }),
    rememberVix: (lastGoodVix) => set({ lastGoodVix }),
    rememberBtc: (lastGoodBtc) => set({ lastGoodBtc }),
    rememberSpx: (lastGoodSpx) => set({ lastGoodSpx }),
    markManualFgUpdate: () => set({ manualFgUpdateMs: Date.now() }),
    markManualVixUpdate: () => set({ manualVixUpdateMs: Date.now() }),
  })),
);
