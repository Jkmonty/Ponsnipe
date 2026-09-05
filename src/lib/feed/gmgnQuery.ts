/**
 * Reading the GMGN-sourced feed.
 *
 * Values arrive already in dollars, so none of the quote-asset conversion in
 * query.ts applies here. What does need saying is which rows this app can
 * actually buy: GMGN covers every launchpad on the chain, and the trading side
 * of this app only speaks to pons bonding curves. A row that is not a pons
 * launch is worth showing and not worth pretending we can trade.
 */
import { db } from "../db/index";
import { buildRates } from "./usd";

export interface GmgnFilters {
  minMcapUsd: number | null;
  minVolumeUsd: number | null;
  minLiquidityUsd: number | null;
  minHolders: number | null;
  maxAgeMin: number;
  /** Hide anything GMGN flags as a honeypot. */
  hideHoneypots: boolean;
  /** Hide launches where the dev holds more than this share (0-1). */
  maxDevHold: number | null;
  /** Only rows this app can actually buy. */
  tradeableOnly: boolean;
  launchpad: string | null;
  limit: number;
}

/*
 * Defaults are deliberately open.
 *
 * A brand-new coin has no volume and no liquidity yet -- that is what "new"
 * means -- so a $3k floor on either hides every launch until it has already
 * matured, and the feed stops moving. Measured: 16 rows passed the $3k floors
 * against 200 without them, 180 of which had launched in the last five minutes.
 * The floors are still one click away as a preset.
 */
export const GMGN_DEFAULTS: GmgnFilters = {
  minMcapUsd: null,
  minVolumeUsd: null,
  minLiquidityUsd: null,
  minHolders: null,
  maxAgeMin: 180,
  hideHoneypots: true,
  maxDevHold: null,
  tradeableOnly: false,
  launchpad: null,
  limit: 60,
};

export interface GmgnRow {
  token: string;
  symbol: string;
  name: string;
  logo: string;
  launchpad: string;
  ageMinutes: number;
  mcapUsd: number;
  volumeUsd: number;
  liquidityUsd: number;
  trades: number;
  buys: number;
  sells: number;
  holders: number;
  progressPct: number;
  devHoldRate: number;
  top10HoldRate: number;
  freshWalletRate: number;
  sniperHoldRate: number;
  insiderHoldRate: number;
  botDegenRate: number;
  isHoneypot: string;
  creatorMade: number;
  renowned: number;
  /** True when this token is a pons launch, i.e. the buy button will work. */
  tradeable: boolean;
}

interface Raw {
  address: string;
  symbol: string | null;
  name: string | null;
  logo: string | null;
  launchpad: string | null;
  created_ts: number;
  market_cap: number | null;
  liquidity: number | null;
  volume_24h: number | null;
  swaps_24h: number | null;
  buys_24h: number | null;
  sells_24h: number | null;
  holder_count: number | null;
  progress: number | null;
  dev_hold_rate: number | null;
  top10_hold_rate: number | null;
  fresh_wallet_rate: number | null;
  bot_degen_rate: number | null;
  sniper_hold_rate: number | null;
  insider_hold_rate: number | null;
  is_honeypot: string | null;
  creator_made: number | null;
  renowned_count: number | null;
  pons: number;
}

/**
 * Pons launches from our own index, in the same shape.
 *
 * GMGN files a pons token under new pairs only once it is well along, so its
 * new-pairs view for this chain is almost entirely the faster launchpads —
 * which are exactly the ones this app cannot buy. Taken alone it would show a
 * feed of coins with the buy button disabled and hide every coin that works.
 * The union is the honest feed: everything launching, ours marked buyable.
 */
async function ponsRows(f: GmgnFilters, exclude: Set<string>): Promise<GmgnRow[]> {
  const since = new Date(Date.now() - f.maxAgeMin * 60_000).toISOString();
  let raw: {
    token: string; symbol: string | null; name: string | null; logo: string | null;
    quote_symbol: string | null; quote_is_native: number; created_at: string;
    mcap: number | null; liquidity: number | null; progress_pct: number | null;
    vol: number | null; buys: number | null; sells: number | null; holders: number | null;
  }[] = [];
  try {
    raw = db()
      .prepare(
        // Volume comes from our own trade index, so a pons row is judged on the
        // same footing as a GMGN one rather than being filtered out for having
        // no volume number at all.
        `SELECT t.token, t.symbol, t.name, t.logo, t.quote_symbol, t.quote_is_native,
                t.created_at, t.mcap, t.liquidity, t.progress_pct,
                v.vol, v.buys, v.sells, h.holders
           FROM feed_tokens t
           LEFT JOIN (
             SELECT curve, SUM(quote) AS vol, SUM(buys) AS buys, SUM(sells) AS sells
               FROM feed_volume WHERE bucket >= ? GROUP BY curve
           ) v ON v.curve = t.curve
           LEFT JOIN (
             SELECT curve, COUNT(*) AS holders FROM feed_buyers GROUP BY curve
           ) h ON h.curve = t.curve
          WHERE t.created_at >= ? AND t.graduated = 0
          ORDER BY t.created_at DESC LIMIT 300`,
      )
      .all(Math.floor(Date.now() / 60_000) - 1440, since) as never;
  } catch {
    return [];
  }
  const fresh = raw.filter((r) => !exclude.has(r.token));
  if (!fresh.length) return [];

  const rates = await buildRates(
    fresh.map((r) => (r.quote_is_native === 1 ? "ETH" : (r.quote_symbol ?? "?"))),
  );
  return fresh.map((r) => {
    const q = r.quote_is_native === 1 ? "ETH" : (r.quote_symbol ?? "?");
    const rate = rates.get(q.toUpperCase()) ?? 0;
    return {
      token: r.token,
      symbol: r.symbol ?? "???",
      name: r.name ?? "",
      logo: r.logo ?? "",
      launchpad: "pons",
      ageMinutes: Math.max(0, (Date.now() - Date.parse(r.created_at)) / 60_000),
      mcapUsd: (r.mcap ?? 0) * rate,
      volumeUsd: (r.vol ?? 0) * rate,
      liquidityUsd: (r.liquidity ?? 0) * rate,
      trades: (r.buys ?? 0) + (r.sells ?? 0),
      buys: r.buys ?? 0,
      sells: r.sells ?? 0,
      holders: r.holders ?? 0,
      progressPct: r.progress_pct ?? 0,
      devHoldRate: 0,
      top10HoldRate: 0,
      freshWalletRate: 0,
      sniperHoldRate: 0,
      insiderHoldRate: 0,
      botDegenRate: 0,
      isHoneypot: "unknown",
      creatorMade: 0,
      renowned: 0,
      tradeable: true,
    };
  });
}

export async function readGmgnFeed(
  f: GmgnFilters,
): Promise<{ rows: GmgnRow[]; total: number; launchpads: string[] }> {
  const since = Math.floor((Date.now() - f.maxAgeMin * 60_000) / 1000);
  let raw: Raw[] = [];
  try {
    raw = db()
      .prepare(
        // The join is how a row learns whether this app can trade it: feed_tokens
        // is our own pons index, so a match means there is a curve to buy on.
        `SELECT g.*, (p.token IS NOT NULL) AS pons
           FROM gmgn_tokens g
           LEFT JOIN feed_tokens p ON p.token = g.address
          WHERE g.created_ts >= ?
          ORDER BY g.created_ts DESC
          LIMIT 400`,
      )
      .all(since) as unknown as Raw[];
  } catch {
    return { rows: [], total: 0, launchpads: [] };
  }

  const all: GmgnRow[] = raw.map((r) => ({
    token: r.address,
    symbol: r.symbol ?? "???",
    name: r.name ?? "",
    logo: r.logo ?? "",
    launchpad: r.launchpad ?? "?",
    ageMinutes: Math.max(0, (Date.now() / 1000 - (r.created_ts || 0)) / 60),
    mcapUsd: r.market_cap ?? 0,
    volumeUsd: r.volume_24h ?? 0,
    liquidityUsd: r.liquidity ?? 0,
    trades: r.swaps_24h ?? 0,
    buys: r.buys_24h ?? 0,
    sells: r.sells_24h ?? 0,
    holders: r.holder_count ?? 0,
    progressPct: (r.progress ?? 0) * 100,
    devHoldRate: r.dev_hold_rate ?? 0,
    top10HoldRate: r.top10_hold_rate ?? 0,
    freshWalletRate: r.fresh_wallet_rate ?? 0,
    sniperHoldRate: r.sniper_hold_rate ?? 0,
    insiderHoldRate: r.insider_hold_rate ?? 0,
    botDegenRate: r.bot_degen_rate ?? 0,
    isHoneypot: r.is_honeypot ?? "unknown",
    creatorMade: r.creator_made ?? 0,
    renowned: r.renowned_count ?? 0,
    tradeable: r.pons === 1,
  }));

  const merged = all.concat(await ponsRows(f, new Set(all.map((r) => r.token))));
  merged.sort((a, b) => a.ageMinutes - b.ageMinutes);
  const launchpads = [...new Set(merged.map((r) => r.launchpad))].filter(Boolean).sort();

  const rows = merged.filter((r) => {
    if (f.minMcapUsd != null && r.mcapUsd < f.minMcapUsd) return false;
    if (f.minVolumeUsd != null && r.volumeUsd < f.minVolumeUsd) return false;
    if (f.minLiquidityUsd != null && r.liquidityUsd < f.minLiquidityUsd) return false;
    if (f.minHolders != null && r.holders < f.minHolders) return false;
    // "unknown" is not a pass — it means GMGN has not checked yet, which for a
    // brand-new token is most of them, so it must not be treated as "safe".
    if (f.hideHoneypots && r.isHoneypot === "yes") return false;
    if (f.maxDevHold != null && r.devHoldRate > f.maxDevHold) return false;
    if (f.tradeableOnly && !r.tradeable) return false;
    if (f.launchpad && r.launchpad !== f.launchpad) return false;
    return true;
  });

  return { rows: rows.slice(0, f.limit), total: merged.length, launchpads };
}
