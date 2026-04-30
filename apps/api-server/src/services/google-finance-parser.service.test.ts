import { describe, expect, it } from "vitest";
import { parseGoogleFinanceQuoteHtml } from "./google-finance-parser.service.js";

function afQuoteRecord(args: {
  ticker: string;
  exchange: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  previousClose?: number;
}): string {
  const previousClose =
    args.previousClose === undefined ? "" : `,null,${args.previousClose}`;
  return (
    `AF_initDataCallback({key: 'ds:2', data:[[[[` +
    `"/m/test",["${args.ticker}","${args.exchange}"],"${args.name}",0,"USD",` +
    `[${args.price},${args.change},${args.changePercent},2,2,2]${previousClose},` +
    `"#666666","US"]]]], sideChannel: {}});`
  );
}

describe("parseGoogleFinanceQuoteHtml", () => {
  it("parses legacy Google Finance price markup", () => {
    const quote = parseGoogleFinanceQuoteHtml(
      '<html><div class="zzDege">Apple Inc.</div><div data-last-price="180.50"></div><div class="P6K39c">$179.00</div></html>',
      { tickerFormat: "AAPL:NASDAQ" }
    );

    expect(quote).toMatchObject({
      ticker: "AAPL",
      exchange: "NASDAQ",
      name: "Apple Inc.",
      price: 180.5,
      previousClose: 179,
      change: 1.5,
    });
    expect(quote?.changePercent).toBeCloseTo(0.838, 3);
  });

  it("parses AF_initDataCallback quote data when data-last-price is absent", () => {
    const quote = parseGoogleFinanceQuoteHtml(
      afQuoteRecord({
        ticker: "AAPL",
        exchange: "NASDAQ",
        name: "Apple Inc",
        price: 274.39,
        change: 4.220001,
        changePercent: 1.5619799,
        previousClose: 270.17,
      }),
      { tickerFormat: "AAPL:NASDAQ" }
    );

    expect(quote).toMatchObject({
      ticker: "AAPL",
      exchange: "NASDAQ",
      name: "Apple Inc",
      price: 274.39,
      previousClose: 270.17,
      change: 4.22,
    });
    expect(quote?.changePercent).toBeCloseTo(1.562, 3);
  });

  it("prefers structured AF data over stale legacy markup", () => {
    const quote = parseGoogleFinanceQuoteHtml(
      '<html><div data-last-price="2009"></div><div class="P6K39c">2008</div></html>' +
        afQuoteRecord({
          ticker: "AVGO",
          exchange: "NASDAQ",
          name: "Broadcom Inc",
          price: 200.9,
          change: 1,
          changePercent: 0.4998,
          previousClose: 199.9,
        }),
      { tickerFormat: "AVGO:NASDAQ" }
    );

    expect(quote).toMatchObject({
      ticker: "AVGO",
      exchange: "NASDAQ",
      name: "Broadcom Inc",
      price: 200.9,
      previousClose: 199.9,
      change: 1,
    });
  });

  it("matches dotted Google Finance symbols in AF_initDataCallback data", () => {
    const quote = parseGoogleFinanceQuoteHtml(
      afQuoteRecord({
        ticker: ".INX",
        exchange: "INDEXSP",
        name: "S&P 500",
        price: 6684.76,
        change: 17.6,
        changePercent: 0.26397,
        previousClose: 6667.16,
      }),
      { tickerFormat: ".INX:INDEXSP" }
    );

    expect(quote).toMatchObject({
      ticker: ".INX",
      exchange: "INDEXSP",
      name: "S&P 500",
      price: 6684.76,
      previousClose: 6667.16,
    });
  });

  it("derives previous close from price and change when AF data omits it", () => {
    const quote = parseGoogleFinanceQuoteHtml(
      afQuoteRecord({
        ticker: "TSLA",
        exchange: "NASDAQ",
        name: "Tesla Inc",
        price: 383.6,
        change: 8.42,
        changePercent: 2.24,
      }),
      { tickerFormat: "TSLA:NASDAQ" }
    );

    expect(quote?.previousClose).toBe(375.18);
    expect(quote?.change).toBeCloseTo(8.42, 4);
  });

  it("selects the requested ticker when multiple AF records are present", () => {
    const quote = parseGoogleFinanceQuoteHtml(
      afQuoteRecord({
        ticker: "MSFT",
        exchange: "NASDAQ",
        name: "Microsoft Corp",
        price: 407.4,
        change: -3.2,
        changePercent: -0.78,
        previousClose: 410.6,
      }) +
        afQuoteRecord({
          ticker: "QQQ",
          exchange: "NASDAQ",
          name: "Invesco QQQ Trust, Series 1",
          price: 668.16,
          change: 6.589966,
          changePercent: 0.99611014,
          previousClose: 661.57,
        }),
      { tickerFormat: "QQQ:NASDAQ" }
    );

    expect(quote).toMatchObject({
      ticker: "QQQ",
      name: "Invesco QQQ Trust, Series 1",
      price: 668.16,
    });
  });

  it("rejects incomplete AF data", () => {
    const quote = parseGoogleFinanceQuoteHtml(
      `AF_initDataCallback({key: 'ds:2', data:[[[["/m/test",["AAPL","NASDAQ"],"Apple Inc",0,"USD",[null,4.22,1.56],null,270.17]]]], sideChannel: {}});`,
      { tickerFormat: "AAPL:NASDAQ" }
    );

    expect(quote).toBeNull();
  });

  it("extracts extended-hours price from AF data", () => {
    const html =
      `AF_initDataCallback({key: 'ds:2', data:[[[[` +
      `"/m/test",["AAPL","NASDAQ"],"Apple Inc",0,"USD",` +
      `[271.35,1.18,0.4368,2,2,2],null,270.17,` +
      `"#666666","US","/m/0k8z",[1777585274],"America/New_York",-14400,"/m/test",` +
      `null,[283,11.65,4.2933,2,2,2],[1777579201],[1777585273],` +
      `[[1,[2026,4,30,9,30,null,null,[-14400]],[2026,4,30,16,null,null,null,[-14400]]]],` +
      `null,"AAPL:NASDAQ",0,null,null,null,0]]]], sideChannel: {}});`;

    const quote = parseGoogleFinanceQuoteHtml(html, { tickerFormat: "AAPL:NASDAQ" });

    expect(quote).toMatchObject({
      ticker: "AAPL",
      price: 271.35,
      previousClose: 270.17,
      extendedPrice: 283,
      extendedChange: 11.65,
      extendedChangePercent: 4.2933,
    });
  });

  it("returns no extended fields when AF data has no extended array", () => {
    const quote = parseGoogleFinanceQuoteHtml(
      afQuoteRecord({
        ticker: "AAPL",
        exchange: "NASDAQ",
        name: "Apple Inc",
        price: 271.35,
        change: 1.18,
        changePercent: 0.4368,
        previousClose: 270.17,
      }),
      { tickerFormat: "AAPL:NASDAQ" }
    );

    expect(quote?.extendedPrice).toBeUndefined();
  });
});
