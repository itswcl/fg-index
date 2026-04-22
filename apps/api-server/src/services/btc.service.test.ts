import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ticker.service.js", () => ({
  fetchTickerQuote: vi.fn(),
}));

import { fetchTickerQuote } from "./ticker.service.js";
import { fetchBtcData } from "./btc.service.js";

const fetchTickerQuoteMock = fetchTickerQuote as unknown as ReturnType<typeof vi.fn>;

describe("btc service", () => {
  beforeEach(() => {
    fetchTickerQuoteMock.mockReset();
  });

  it("delegates to the shared ticker fetcher for BTC-USD", async () => {
    fetchTickerQuoteMock.mockResolvedValue({ ticker: "BTC-USD", price: 79000 });

    const quote = await fetchBtcData();

    expect(fetchTickerQuoteMock).toHaveBeenCalledWith("BTC-USD");
    expect(quote).toEqual({ ticker: "BTC-USD", price: 79000 });
  });
});
