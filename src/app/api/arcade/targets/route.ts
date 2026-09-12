import { json, errorJson } from "@/lib/api";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The stocks to shoot at, and which way they moved today.
 *
 * Taken from the quote assets the feed is actually using rather than a list
 * somebody typed, so the targets are the shares this chain trades against. The
 * day's move decides what each one does in the game: the ones that are up are
 * worth points, the ones that are down shoot back.
 *
 * That is the whole reason to build the game on real data instead of invented
 * targets. A red one is genuinely having a bad day, and the player learns the
 * tickers without being taught them.
 */
const TTL_MS = 120_000;
const g = globalThis as typeof globalThis & {
  __ponsTargets?: { at: number; data: Target[] };
};

interface Target {
  symbol: string;
  price: number;
  changePct: number;
  /** How many live launches are priced against it — how common it is here. */
  launches: number;
}

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

export async function GET() {
  try {
    const hit = g.__ponsTargets;
    if (hit && Date.now() - hit.at < TTL_MS) return json({ targets: hit.data });

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
    return json({ targets });
  } catch (err) {
    return errorJson(err instanceof Error ? err.message : "could not load targets", 502);
  }
}
