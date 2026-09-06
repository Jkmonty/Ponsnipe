/**
 * Reading the pons new-pairs feed.
 *
 * One source: our own on-chain index. GMGN was wired in for a while to cover
 * the other launchpads on this chain, and it is gone — its new-token stream
 * does not carry pons launches at all (they surface there only once graduated,
 * by which point they are hours to weeks old), so for pons specifically it was
 * never the better source. Everything here comes from TokenLaunched on the pons
 * factory, priced from curve reserves the trade stream keeps exact.
 *
 * Every row is therefore a token this app can actually buy.
 */
import { db } from "../db/index";
import { buildRates } from "./usd";

export interface FeedFilters {
  /** How far back to read. Rows are returned newest first. */
  maxAgeMin: number;
  limit: number;
}

export const DEFAULT_FILTERS: FeedFilters = {
  maxAgeMin: 180,
  limit: 250,
};

export interface FeedRow {
  token: string;
  curve: string;
  symbol: string;
  name: string;
  logo: string;
  /** The asset the curve trades against — ETH, USDG, NVDA and so on. */
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
  /** Distinct wallets that have bought, from the trade stream. */
  holders: number;
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
  holders: number | null;
}

export async function readFeed(
  f: FeedFilters,
): Promise<{ rows: FeedRow[]; total: number; ethUsd: number | null; unpriced: string[] }> {
  const since = new Date(Date.now() - f.maxAgeMin * 60_000).toISOString();
  /*
   * Read wider than we return, then slice.
   *
   * This was once a flat LIMIT 300, which at ~29 launches a minute meant the
   * feed only ever considered the last ten minutes: 519 rows offered from an
   * index holding 5,293, so a coin seen a quarter of an hour earlier could not
   * be found at any display limit. Only `limit` rows go over the wire either
   * way, so reading deep costs a wider query and nothing else.
   */
  const depth = Math.min(2000, Math.max(600, f.limit * 4));

  let raw: Raw[] = [];
  try {
    raw = db()
      .prepare(
        `SELECT t.token, t.curve, t.symbol, t.name, t.logo, t.quote_symbol,
                t.quote_is_native, t.created_at, t.price, t.mcap, t.liquidity,
                t.progress_pct, v.vol, v.buys, v.sells, h.holders
           FROM feed_tokens t
           LEFT JOIN (
             SELECT curve, SUM(quote) AS vol, SUM(buys) AS buys, SUM(sells) AS sells
               FROM feed_volume WHERE bucket >= ? GROUP BY curve
           ) v ON v.curve = t.curve
           LEFT JOIN (
             SELECT curve, COUNT(*) AS holders FROM feed_buyers GROUP BY curve
           ) h ON h.curve = t.curve
          WHERE t.created_at >= ? AND t.graduated = 0
          ORDER BY t.created_at DESC
          LIMIT ?`,
      )
      .all(Math.floor(Date.now() / 60_000) - 1440, since, depth) as unknown as Raw[];
  } catch {
    return { rows: [], total: 0, ethUsd: null, unpriced: [] };
  }
  if (!raw.length) return { rows: [], total: 0, ethUsd: null, unpriced: [] };

  const quoteOf = (r: Raw) => (r.quote_is_native === 1 ? "ETH" : (r.quote_symbol ?? "?"));
  // One rate lookup per distinct quote asset, not per row.
  const rates = await buildRates(raw.map(quoteOf));
  const unpriced = new Set<string>();

  const rows: FeedRow[] = raw.map((r) => {
    const quoteSymbol = quoteOf(r);
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
      holders: r.holders ?? 0,
      progressPct: r.progress_pct ?? 0,
      priceQuote: r.price ?? 0,
    };
  });

  return {
    rows: rows.slice(0, f.limit),
    total: rows.length,
    ethUsd: rates.get("ETH") ?? null,
    unpriced: [...unpriced].sort(),
  };
}
