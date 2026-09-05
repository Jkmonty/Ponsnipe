/**
 * Dollar values for feed numbers.
 *
 * Launches pair against three kinds of asset and each needs a different answer:
 *
 *   ETH          ~47%  spot rate
 *   stablecoins  ~27%  a dollar
 *   tokenised equities ~26%  the share price
 *
 * That last group is the interesting one. NVDA, SPY, TSLA, GME and a couple of
 * dozen more trade here as ERC-20s, and the token contracts expose no oracle —
 * no latestAnswer, no priceFeed, nothing. But they are 1:1 with the real share,
 * so the share price IS the rate, and that is a number anyone can look up.
 *
 * The 1:1 assumption is not taken on trust. Graduated tokens open at a market
 * cap that lands near $39k whichever asset they pair against — 4,494 DJT,
 * 54.62 QQQ, 1,808 GME and 39,640 USDG all convert to within a few percent of
 * each other. Four independent quote assets agreeing is what makes this sound
 * rather than plausible.
 *
 * Everything degrades to "unpriced" rather than to a guess. A market cap filter
 * that silently invented a rate would be worse than one that says it cannot
 * see.
 */
const STABLES = new Set(["USDG", "USDC", "USDT", "DAI", "PYUSD", "USDS", "USD"]);

/**
 * Crypto quote assets, mapped to the Coinbase spot pair that prices them.
 * Looking these up as equity tickers would either miss or, worse, hit an
 * unrelated listing that happens to share the symbol.
 */
const CRYPTO: Record<string, string> = {
  ETH: "ETH-USD",
  WETH: "ETH-USD",
  CBBTC: "BTC-USD",
  WBTC: "BTC-USD",
  BTC: "BTC-USD",
  SOL: "SOL-USD",
};

/** Quote symbols that are never equities, so they are not looked up as ones. */
const NOT_EQUITY = new Set(["?", ""]);

const TTL_MS = 300_000;
/** Yahoo has no working batch endpoint for us, so cap parallel lookups. */
const CONCURRENCY = 6;

interface Cached {
  at: number;
  price: number | null;
}
const gc = globalThis as typeof globalThis & {
  __ponsRates?: Map<string, Cached>;
};
function cache(): Map<string, Cached> {
  gc.__ponsRates ??= new Map();
  return gc.__ponsRates;
}

/** Set to 1 to keep the app entirely on the RPC and show quote units instead. */
const disabled = () => process.env.DISABLE_PRICE_FEEDS === "1";

async function fetchCryptoUsd(pair: string): Promise<number | null> {
  if (pair === "ETH-USD") {
    const pinned = Number(process.env.ETH_USD ?? "");
    if (Number.isFinite(pinned) && pinned > 0) return pinned;
  }
  if (disabled()) return null;
  try {
    const r = await fetch(`https://api.coinbase.com/v2/prices/${pair}/spot`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: { amount?: string } };
    const n = Number(j?.data?.amount);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Last regular-session price for one ticker.
 *
 * Yahoo's v7 batch quote endpoint returns Unauthorized without a session, so
 * this uses the v8 chart endpoint, which needs no key. Outside market hours it
 * reports the previous close, which is the right number for a token that
 * tracks the share.
 */
async function fetchEquityUsd(symbol: string): Promise<number | null> {
  if (disabled()) return null;
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      { signal: AbortSignal.timeout(7000), headers: { "user-agent": "Mozilla/5.0" } },
    );
    if (!r.ok) return null;
    const j = (await r.json()) as {
      chart?: { result?: { meta?: { regularMarketPrice?: number; currency?: string } }[] };
    };
    const meta = j?.chart?.result?.[0]?.meta;
    // A non-USD listing would silently be the wrong number, so require USD.
    if (!meta || meta.currency !== "USD") return null;
    const n = Number(meta.regularMarketPrice);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function rateFor(symbol: string): Promise<number | null> {
  const key = symbol.toUpperCase();
  const hit = cache().get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.price;

  let price: number | null;
  const pair = CRYPTO[key];
  if (pair) price = await fetchCryptoUsd(pair);
  else if (STABLES.has(key)) price = 1;
  else if (NOT_EQUITY.has(key)) price = null;
  else price = await fetchEquityUsd(key);

  // Failures are cached too, briefly, so a delisted or unknown ticker is not
  // re-requested on every poll.
  cache().set(key, { at: Date.now(), price });
  return price;
}

/**
 * Dollar rate for each quote symbol in use, looked up in small batches.
 * A symbol absent from the returned map has no known rate.
 */
export async function buildRates(symbols: string[]): Promise<Map<string, number>> {
  const want = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const out = new Map<string, number>();

  for (let i = 0; i < want.length; i += CONCURRENCY) {
    const slice = want.slice(i, i + CONCURRENCY);
    const got = await Promise.all(slice.map(async (s) => [s, await rateFor(s)] as const));
    for (const [s, p] of got) if (p != null) out.set(s, p);
  }
  return out;
}

/** Convenience for callers that only need ETH, e.g. the feed header. */
export async function ethUsd(): Promise<number | null> {
  return rateFor("ETH");
}
