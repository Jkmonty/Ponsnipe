/**
 * Reading the feed: join tokens to their rolling volume, convert to dollars
 * where possible, then filter.
 *
 * Filtering happens after conversion rather than in SQL, because the thresholds
 * are in dollars and the stored numbers are in each token's own quote asset.
 */
import { db } from "../db/index";
import { buildRates, ethUsd } from "./usd";

export interface FeedFilters {
  /** Dollar floors. null = off. */
  minMcapUsd: number | null;
  minVolumeUsd: number | null;
  minLiquidityUsd: number | null;
  /** Trades in the volume window. */
  minTrades: number | null;
  /** Minutes of volume to total up, and the age window for the list. */
  volumeWindowMin: number;
  maxAgeMin: number;
  /**
   * Tokens quoted in something we have no dollar rate for — the tokenised
   * stocks. Off by default: with a dollar filter set, including things the
   * filter cannot actually test would quietly defeat it.
   */
  includeUnpriced: boolean;
  quote: "all" | "eth" | "stable";
  limit: number;
}

export const DEFAULT_FILTERS: FeedFilters = {
  minMcapUsd: 3000,
  minVolumeUsd: 3000,
  minLiquidityUsd: 3000,
  minTrades: null,
  volumeWindowMin: 60,
  maxAgeMin: 180,
  includeUnpriced: false,
  quote: "all",
  limit: 60,
};

export interface FeedRow {
  token: string;
  curve: string;
  symbol: string;
  name: string;
  logo: string;
  quoteSymbol: string;
  ageMinutes: number;
  /** In the quote asset. */
  mcap: number;
  volume: number;
  liquidity: number;
  /** In dollars, or null when the quote asset has no known rate. */
  mcapUsd: number | null;
  volumeUsd: number | null;
  liquidityUsd: number | null;
  buys: number;
  sells: number;
  trades: number;
  progressPct: number;
  priceQuote: number;
}

interface Raw {
  token: string;
  curve: string;
  symbol: string | null;
  name: string | null;
  logo: string | null;
  quote_symbol: string | null;
  quote_is_native: number;
  created_at: string;
  price: number | null;
  mcap: number | null;
  liquidity: number | null;
  progress_pct: number | null;
  vol: number | null;
  buys: number | null;
  sells: number | null;
}

export async function readFeed(
  f: FeedFilters,
): Promise<{ rows: FeedRow[]; ethUsd: number | null; total: number; unpriced: string[] }> {
  const eth = await ethUsd();
  const sinceBucket = Math.floor(Date.now() / 60_000) - Math.max(1, f.volumeWindowMin);
  const sinceTs = new Date(Date.now() - f.maxAgeMin * 60_000).toISOString();

  let raw: Raw[] = [];
  try {
    raw = db()
      .prepare(
        `SELECT t.token, t.curve, t.symbol, t.name, t.logo, t.quote_symbol, t.quote_is_native,
                t.created_at, t.price, t.mcap, t.liquidity, t.progress_pct,
                v.vol, v.buys, v.sells
           FROM feed_tokens t
           LEFT JOIN (
             SELECT curve, SUM(quote) AS vol, SUM(buys) AS buys, SUM(sells) AS sells
               FROM feed_volume WHERE bucket >= ? GROUP BY curve
           ) v ON v.curve = t.curve
          WHERE t.created_at >= ? AND t.graduated = 0
          ORDER BY t.created_at DESC
          LIMIT 600`,
      )
      .all(sinceBucket, sinceTs) as unknown as Raw[];
  } catch {
    return { rows: [], ethUsd: eth, total: 0, unpriced: [] };
  }

  // One rate lookup per distinct quote asset in the window, not per row.
  const rates = await buildRates(
    raw.map((r) => (r.quote_is_native === 1 ? "ETH" : (r.quote_symbol ?? "?"))),
  );
  const unpriced = new Set<string>();

  const all: FeedRow[] = raw.map((r) => {
    const quoteSymbol = r.quote_is_native === 1 ? "ETH" : (r.quote_symbol ?? "?");
    const rate = rates.get(quoteSymbol.toUpperCase()) ?? null;
    if (rate == null) unpriced.add(quoteSymbol);
    const mcap = r.mcap ?? 0;
    const volume = r.vol ?? 0;
    const liquidity = r.liquidity ?? 0;
    const buys = r.buys ?? 0;
    const sells = r.sells ?? 0;
    return {
      token: r.token,
      curve: r.curve,
      symbol: r.symbol ?? "???",
      name: r.name ?? "",
      logo: r.logo ?? "",
      quoteSymbol,
      ageMinutes: Math.max(0, (Date.now() - Date.parse(r.created_at)) / 60_000),
      mcap,
      volume,
      liquidity,
      mcapUsd: rate == null ? null : mcap * rate,
      volumeUsd: rate == null ? null : volume * rate,
      liquidityUsd: rate == null ? null : liquidity * rate,
      buys,
      sells,
      trades: buys + sells,
      progressPct: r.progress_pct ?? 0,
      priceQuote: r.price ?? 0,
    };
  });

  const rows = all.filter((row) => {
    if (f.quote === "eth" && row.quoteSymbol !== "ETH") return false;
    if (f.quote === "stable" && row.quoteSymbol === "ETH") return false;

    const unpriced = row.mcapUsd == null;
    const hasDollarFilter =
      f.minMcapUsd != null || f.minVolumeUsd != null || f.minLiquidityUsd != null;
    if (unpriced) {
      // Nothing to test a dollar threshold against, so this is a policy choice
      // rather than a comparison.
      if (hasDollarFilter && !f.includeUnpriced) return false;
    } else {
      if (f.minMcapUsd != null && (row.mcapUsd ?? 0) < f.minMcapUsd) return false;
      if (f.minVolumeUsd != null && (row.volumeUsd ?? 0) < f.minVolumeUsd) return false;
      if (f.minLiquidityUsd != null && (row.liquidityUsd ?? 0) < f.minLiquidityUsd) return false;
    }
    if (f.minTrades != null && row.trades < f.minTrades) return false;
    return true;
  });

  return {
    rows: rows.slice(0, f.limit),
    ethUsd: eth,
    total: all.length,
    unpriced: [...unpriced].sort(),
  };
}
