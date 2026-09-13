import { db } from "./db";

/**
 * The stocks to shoot at, and which way they moved today.
 *
 * Taken from the quote assets the feed is actually using rather than a list
 * somebody typed, so the targets are the shares this chain trades against. The
 * day's move decides what each one does in the game: the ones that are up are
 * worth points, the ones that are down shoot back.
 *
 * Lifted out of the route handler so the landing page can pin the same three
 * tickers to its target on the server, in the first paint, without an HTTP
 * round trip to itself.
 */
export interface Target {
  symbol: string;
  price: number;
  changePct: number;
  /** How many live launches are priced against it — how common it is here. */
  launches: number;
}

/** One ticker pinned to the hero's target. */
export interface Pin {
  symbol: string;
  changePct: number;
  /** Up or flat on the day. The game treats flat as green too. */
  up: boolean;
}

/** The `n` most-used targets, most used first. Pure; does not touch the input. */
export function pickPins(targets: Target[], n = 3): Pin[] {
  return [...targets]
    .sort((a, b) => b.launches - a.launches)
    .slice(0, Math.max(0, n))
    .map((t) => ({ symbol: t.symbol, changePct: t.changePct, up: t.changePct >= 0 }));
}

const TTL_MS = 120_000;
const g = globalThis as typeof globalThis & {
  __ponsTargets?: { at: number; data: Target[] };
};

/**
 * Price and day's move in one call.
 *
 * The same Yahoo chart endpoint usd.ts uses, which needs no key. Its meta
 * carries the previous close beside the current price, so the move costs
 * nothing extra to work out.
 */
async function quote(symbol: string): Promise<{ price: number; changePct: number } | null> {
  if (process.env.DISABLE_PRICE_FEEDS === "1") return null;
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`,
      { signal: AbortSignal.timeout(7000), headers: { "user-agent": "Mozilla/5.0" } },
    );
    if (!r.ok) return null;
    const j = (await r.json()) as {
      chart?: {
        result?: {
          meta?: { regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number; currency?: string };
        }[];
      };
    };
    const m = j?.chart?.result?.[0]?.meta;
    if (!m || m.currency !== "USD") return null;
    const price = Number(m.regularMarketPrice);
    const prev = Number(m.chartPreviousClose ?? m.previousClose);
    if (!(price > 0)) return null;
    // No previous close means no move to report — flat rather than invented.
    const changePct = prev > 0 ? ((price - prev) / prev) * 100 : 0;
    return { price, changePct };
  } catch {
    return null;
  }
}

/** The targets, cached two minutes. Throws only if the database is unreadable. */
export async function loadTargets(): Promise<Target[]> {
  const hit = g.__ponsTargets;
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const rows = db()
    .prepare(
      `SELECT quote_symbol AS symbol, COUNT(*) AS launches
         FROM feed_tokens
        WHERE quote_is_native = 0 AND quote_symbol IS NOT NULL
        GROUP BY quote_symbol ORDER BY launches DESC LIMIT 24`,
    )
    .all() as { symbol: string; launches: number }[];

  // Stablecoins and wrapped crypto are not shares and have no day to have.
  const skip = new Set(["USDG", "USDC", "USDT", "DAI", "CBBTC", "WBTC", "WETH", "?"]);
  const want = rows.filter((r) => !skip.has(r.symbol.toUpperCase()));

  const got = await Promise.all(
    want.map(async (r) => {
      const q = await quote(r.symbol);
      return q ? { symbol: r.symbol, launches: r.launches, ...q } : null;
    }),
  );
  const targets = got.filter(Boolean) as Target[];
  g.__ponsTargets = { at: Date.now(), data: targets };
  return targets;
}
