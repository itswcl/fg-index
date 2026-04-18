import { env } from "../config/env.js";
import { FearGreed, FearGreedClassification } from "@shared/types";
import { z } from "zod";

const CnnRawSchema = z.object({
  fear_and_greed: z.object({
    score: z.number(),
    rating: z.string(),
    timestamp: z.string(),
    previous_close: z.number(),
    previous_1_week: z.number(),
    previous_1_month: z.number(),
    previous_1_year: z.number(),
  }),
});

function mapRatingToClassification(rating: string): FearGreedClassification {
  const normalized = rating.toLowerCase().trim();
  if (normalized.includes("extreme fear")) return "Extreme Fear";
  if (normalized === "fear") return "Fear";
  if (normalized === "neutral") return "Neutral";
  if (normalized === "greed") return "Greed";
  if (normalized.includes("extreme greed")) return "Extreme Greed";
  if (normalized.includes("fear")) return "Fear";
  if (normalized.includes("greed")) return "Greed";
  return "Neutral";
}

export async function fetchCnnData(): Promise<Omit<FearGreed, 'isMarketOpen' | 'lastUpdated'>> {
  const today = new Date().toISOString().split("T")[0];
  const url = `${env.CNN_FEAR_GREED_URL}${today}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": env.SCRAPER_USER_AGENT,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`CNN API error: ${response.statusText}`);
  }

  const rawData = await response.json();
  const parsed = CnnRawSchema.parse(rawData);
  const data = parsed.fear_and_greed;

  return {
    score: Math.round(data.score),
    classification: mapRatingToClassification(data.rating),
    previousClose: Math.round(data.previous_close),
    oneWeekAgo: Math.round(data.previous_1_week),
    oneMonthAgo: Math.round(data.previous_1_month),
    oneYearAgo: Math.round(data.previous_1_year),
    updatedAt: data.timestamp,
    // CNN's public user-facing page. We scrape from an internal JSON
    // endpoint (`production.dataviz.cnn.io/...`) but surface the human-
    // readable URL so the UI can link through for verification.
    sourceUrl: "https://www.cnn.com/markets/fear-and-greed",
  };
}
