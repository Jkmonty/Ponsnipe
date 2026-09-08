/**
 * The new-coins feed.
 *
 * Independent of the sniper on purpose: the feed is the thing you look at, and
 * it has to keep working whether or not anything is armed to trade.
 *
 * Three sweeps, all built on chain-wide log queries rather than per-token
 * polling, because a feed of a few hundred live curves cannot afford a round
 * trip each:
 *
 *   1. TokenLaunched on the factory  -> new tokens enter the feed
 *   2. CurveBuy / CurveSell, no address filter -> every trade on every curve in
 *      one query, grouped by the emitting curve, which is what makes real
 *      volume affordable
 *   3. a multicall over the curves in the window -> reserves, and from those
 *      price, market cap and liquidity
 *
 * Everything is stored in the token's own quote asset. Converting to dollars is
 * a presentation concern and lives in usd.ts, because roughly a quarter of
 * launches pair against tokenised stocks we have no dollar rate for.
 */
import { createPublicClient, fallback, http, parseAbiItem, getAddress, type Address, type PublicClient } from "viem";
import { robinhoodChain, redactRpc } from "../chain";
import { PUBLIC_RPC_POOL } from "../env";
import { db, logEngine } from "../db/index";
import { PONS } from "../pons/addresses";
import { ponsFactoryAbi, erc20Abi, bondingCurveAbi } from "../pons/abis";
import { warmImages } from "./images";

/** Every pons v2 token mints the same fixed supply. */
const SUPPLY_RAW = 1e27;
const NATIVE = "0x0000000000000000000000000000000000000000";

const LAUNCH_EVENT = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
);
const BUY_EVENT = parseAbiItem(
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
);
const SELL_EVENT = parseAbiItem(
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
);

/**
 * Log sweeps use their own endpoint for the reasons learned elsewhere in this
 * codebase: a provider WebSocket rejects eth_getLogs outright, and Alchemy's
 * free tier caps the range at 10 blocks where the public node allows 2000.
 */
const LOGS_POOL = process.env.LOGS_RPC_URL?.trim()
  ? [process.env.LOGS_RPC_URL.trim()]
  : PUBLIC_RPC_POOL;
let logs: PublicClient | undefined;
function logClient(): PublicClient {
  if (logs) return logs;
  logs = createPublicClient({
    chain: robinhoodChain,
    /*
     * A fallback across every public endpoint, ranked by which is answering.
     *
     * One endpoint used to carry the whole sweep, and its rate limit was the
     * ceiling: shortening the poll interval pushed failures to 13% purely
     * because the calls landed on the same node. Spreading them is what makes
     * a faster sweep affordable.
     */
    transport: fallback(
      LOGS_POOL.map((u) => http(u, { retryCount: 1, timeout: 25_000, batch: true })),
      { retryCount: 0, rank: LOGS_POOL.length > 1 ? { interval: 30_000, sampleCount: 3 } : false },
    ),
  }) as PublicClient;
  return logs;
}

/**
 * Tick interval, and the latency floor for a new coin appearing at all.
 *
 * The three stages do not deserve the same cadence. Finding launches is one
 * cheap getLogs against a single contract and is the whole reason anyone looks
 * at the feed, so it runs every tick. Sweeping every curve trade on the chain
 * costs several queries and repricing costs a multicall; those set the rate
 * limiting, and running them at this speed is what pushed the failure rate to
 * 13%. They run every HEAVY_EVERY ticks instead.
 */
const POLL_MS = Math.max(1_000, Number(process.env.FEED_POLL_MS ?? 2_000));
const HEAVY_EVERY = Math.max(1, Number(process.env.FEED_HEAVY_EVERY ?? 3));
/** Never query more than this many blocks at once. */
const MAX_SPAN = 1_800n;
/**
 * The trade sweep filters by event only, with no address, so it returns every
 * curve trade on the chain — measured at ~726 logs per 500 blocks. The public
 * node accepts that span and refuses 1800, so catch up in chunks of this size
 * rather than widening the window.
 */
const TRADE_CHUNK = 400n;
/** Chunks per pass. Beyond this the sweep skips ahead rather than fall behind. */
const TRADE_MAX_CHUNKS = 6;
/** Tokens leave the feed after this long without being refreshed. */
const KEEP_MINUTES = 180;

/**
 * How long price history is kept, separately from the feed window.
 *
 * The rows themselves are pruned at three hours, and pruning prices on the
 * same clock meant a chart could only ever be as old as the app's last
 * restart — the table is on disk and survives one, but anything older than the
 * feed window was deleted on the next sweep regardless. Twelve hours costs
 * roughly one row per curve per minute, which against the same three-hour
 * population is a few hundred thousand rows at most, and means a coin still in
 * the feed always has its full life drawn rather than a stump.
 */
const PRICE_KEEP_MINUTES = 720;
/*
 * The same history at five-second resolution, kept for two hours.
 *
 * A minute bar is the wrong unit for this market. The median pons coin lives
 * three minutes, so a chart of minute closes draws three points for the
 * typical launch — and the whole decision a sniper makes happens inside those
 * three points. Five seconds is roughly the sweep cadence, so it is as fine as
 * the data honestly goes; anything finer would be drawing the poll interval
 * rather than the market.
 *
 * Only curves that actually trade write rows, so this costs far less than
 * 1,440 rows per curve per two hours in practice.
 */
const TICK_SECONDS = 5;
const TICK_KEEP_HOURS = 2;
/** Curves re-priced per pass. Each costs two calls inside one multicall. */
const PRICE_BATCH = 90;

interface FeedState {
  running: boolean;
  timer: ReturnType<typeof setInterval> | undefined;
  lastLaunchBlock: bigint;
  lastTradeBlock: bigint;
  seen: number;
  sweeps: number;
  lastError: string | null;
  busy: boolean;
}

const g = globalThis as typeof globalThis & { __ponsFeed?: FeedState };
const s: FeedState =
  g.__ponsFeed ??
  (g.__ponsFeed = {
    running: false,
    timer: undefined,
    lastLaunchBlock: 0n,
    lastTradeBlock: 0n,
    seen: 0,
    sweeps: 0,
    lastError: null,
    busy: false,
  });

function migrate(): void {
  const conn = db();
  conn.exec(`
    CREATE TABLE IF NOT EXISTS feed_tokens (
      token           TEXT PRIMARY KEY,
      curve           TEXT NOT NULL,
      deployer        TEXT,
      symbol          TEXT,
      name            TEXT,
      logo            TEXT,
      quote_token     TEXT,
      quote_symbol    TEXT,
      quote_decimals  INTEGER DEFAULT 18,
      quote_is_native INTEGER DEFAULT 0,
      threshold       REAL,
      launch_block    INTEGER,
      created_at      TEXT NOT NULL,
      -- refreshed by the pricing pass
      price           REAL,
      mcap            REAL,
      liquidity       REAL,
      progress_pct    REAL,
      graduated       INTEGER DEFAULT 0,
      priced_at       TEXT,
      -- Exact curve state, carried as wei strings. Seeded by one poll and then
      -- advanced by trade events, which reproduce it to the wei.
      quote_reserve   TEXT,
      token_reserve   TEXT,
      -- getReserves includes the curve's phantom reserve; realQuoteReserve does
      -- not. The difference is fixed per curve, so record it once and real
      -- liquidity stays derivable as the reserves move.
      phantom         TEXT,
      -- Block the reserves are true as of. Events at or before it are already
      -- baked in and must not be applied twice.
      reserves_block  INTEGER DEFAULT 0,
      -- Position within its block, so two launches in the same block keep the
      -- order the chain put them in.
      log_index       INTEGER DEFAULT 0
    );
  `);
  for (const [col, decl] of [
    ["quote_reserve", "TEXT"],
    ["token_reserve", "TEXT"],
    ["phantom", "TEXT"],
    ["reserves_block", "INTEGER DEFAULT 0"],
    ["log_index", "INTEGER DEFAULT 0"],
    ["socials", "TEXT"],
    ["description", "TEXT"],
  ] as const) {
    try {
      conn.exec(`ALTER TABLE feed_tokens ADD COLUMN ${col} ${decl};`);
    } catch {
      /* already present */
    }
  }
  // Chain order, which is what the feed sorts on.
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_feed_block ON feed_tokens(launch_block DESC, log_index DESC);`);
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_feed_created ON feed_tokens(created_at DESC);`);
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_feed_curve ON feed_tokens(curve);`);

  // One row per token per minute. Bucketing rather than storing every trade
  // keeps a busy hour to a few thousand rows instead of tens of thousands,
  // and a minute is finer than any window the UI offers.
  conn.exec(`
    CREATE TABLE IF NOT EXISTS feed_volume (
      curve    TEXT NOT NULL,
      bucket   INTEGER NOT NULL,
      quote    REAL NOT NULL DEFAULT 0,
      buys     INTEGER NOT NULL DEFAULT 0,
      sells    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (curve, bucket)
    );
  `);
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_feed_vol_bucket ON feed_volume(bucket DESC);`);

  /*
   * Last price seen in each minute, per curve.
   *
   * feed_tokens holds only the CURRENT price, which is all the trading engine
   * needs and all a row needs to show — but it means there was no history to
   * draw, so the feed's sparkline had to fall back to volume. One row per
   * curve per minute is enough to draw a line and cheap to keep: retained for
   * PRICE_KEEP_MINUTES, longer than the feed window so a chart survives a
   * restart, and bounded by dropping curves that have left the feed.
   *
   * The write is an upsert, so the last trade in a minute wins. Deliberate —
   * a close is what a chart of minute bars is made of, and keeping every tick
   * would multiply the table by the trade rate for a line 54px wide.
   */
  conn.exec(`
    CREATE TABLE IF NOT EXISTS feed_prices (
      curve  TEXT NOT NULL,
      bucket INTEGER NOT NULL,
      price  REAL NOT NULL,
      PRIMARY KEY (curve, bucket)
    );
  `);
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_feed_price_bucket ON feed_prices(bucket DESC);`);

  // The fine-grained twin of feed_prices. Same shape, smaller bucket, shorter
  // life — see TICK_SECONDS for why a minute is too coarse to chart here.
  conn.exec(`
    CREATE TABLE IF NOT EXISTS feed_ticks (
      curve  TEXT NOT NULL,
      bucket INTEGER NOT NULL,
      price  REAL NOT NULL,
      PRIMARY KEY (curve, bucket)
    );
  `);
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_feed_tick_bucket ON feed_ticks(bucket DESC);`);

  /*
   * Net token position per wallet, per curve.
   *
   * Every CurveBuy carries tokensOut and every CurveSell tokensIn, both already
   * swept, so running them into a balance gives the numbers the paid feeds sell:
   * a real holder count rather than "people who ever bought", how much of the
   * supply the deployer took of their own launch, and how concentrated the top
   * of the book is.
   *
   * It counts curve trading only. A wallet-to-wallet transfer would move tokens
   * without either event, which is rare before graduation but means these are
   * lower bounds rather than a chain-wide balance scan.
   */
  conn.exec(`
    CREATE TABLE IF NOT EXISTS feed_positions (
      curve  TEXT NOT NULL,
      wallet TEXT NOT NULL,
      net    REAL NOT NULL DEFAULT 0,
      -- Block of this wallet's first buy on this curve. What makes a sniper
      -- countable: a wallet in the launch block itself cannot have seen the
      -- launch and reacted to it, it was waiting for the token to exist.
      first_block INTEGER,
      PRIMARY KEY (curve, wallet)
    );
  `);
  try {
    conn.exec(`ALTER TABLE feed_positions ADD COLUMN first_block INTEGER;`);
  } catch {
    /* already present */
  }
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_feed_pos_curve ON feed_positions(curve, net DESC);`);
  // Counting snipers is a range scan per curve, so give it its own index.
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_feed_pos_first ON feed_positions(curve, first_block);`);

  // Where the sweeps got to. Held on disk, not just in memory, so a restart
  // resumes rather than skipping whatever happened while the app was down.
  conn.exec(`
    CREATE TABLE IF NOT EXISTS feed_cursor (
      name  TEXT PRIMARY KEY,
      block INTEGER NOT NULL
    );
  `);
}

function loadCursor(name: string): bigint {
  try {
    const r = db().prepare(`SELECT block FROM feed_cursor WHERE name = ?`).get(name) as
      | { block: number }
      | undefined;
    return r ? BigInt(r.block) : 0n;
  } catch {
    return 0n;
  }
}

function saveCursor(name: string, block: bigint): void {
  try {
    db()
      .prepare(`INSERT INTO feed_cursor (name, block) VALUES (?,?)
                  ON CONFLICT(name) DO UPDATE SET block = excluded.block`)
      .run(name, Number(block));
  } catch {
    /* a cursor that fails to save only costs a re-scan next boot */
  }
}

const nowBucket = () => Math.floor(Date.now() / 60_000);
const nowTick = () => Math.floor(Date.now() / (TICK_SECONDS * 1000));

/** New launches -> feed rows, with the metadata the list needs to render. */
async function sweepLaunches(head: bigint): Promise<void> {
  const c = logClient();
  if (s.lastLaunchBlock === 0n) {
    // Resume where the last run stopped. Falling back to a fixed lookback would
    // silently drop every launch during a restart, which is the one thing a
    // feed claiming to show new coins must not do.
    const saved = loadCursor("launches");
    s.lastLaunchBlock = saved > 0n && head - saved < MAX_SPAN * 20n ? saved : head - 600n;
  }
  let from = s.lastLaunchBlock + 1n;
  if (head < from) return;
  if (head - from > MAX_SPAN) from = head - MAX_SPAN;

  const found = await c.getLogs({ address: PONS.factory, event: LAUNCH_EVENT, fromBlock: from, toBlock: head });
  s.lastLaunchBlock = head;
  saveCursor("launches", head);
  if (!found.length) return;

  await ingestLaunches(
    found
      .map((l) => ({
        token: getAddress(String(l.args.token)),
        curve: getAddress(String(l.args.curve)),
        deployer: getAddress(String(l.args.deployer)),
        pairToken: getAddress(String(l.args.pairToken)),
        threshold: l.args.graduationThreshold as bigint,
        block: l.blockNumber ?? 0n,
        logIndex: l.logIndex ?? 0,
      }))
      .filter((x) => x.token && x.curve),
    head,
  );
}

export interface RawLaunch {
  token: Address;
  curve: Address;
  deployer: Address;
  pairToken: Address;
  threshold: bigint;
  block: bigint;
  /** Position within the block. Two launches in one block are ordered by it. */
  logIndex: number;
}

/**
 * Enrich and store launches: metadata, opening reserves, and a de-dupe against
 * what is already indexed.
 */
export async function ingestLaunches(fresh: RawLaunch[], head: bigint): Promise<number> {
  if (!fresh.length) return 0;
  const c = logClient();

  const known = new Set(
    (db().prepare(`SELECT token FROM feed_tokens`).all() as { token: string }[]).map((r) => r.token),
  );
  const add = fresh.filter((x) => !known.has(x.token.toLowerCase()));
  if (!add.length) return 0;

  /*
   * Metadata AND opening reserves in one call, pinned to one block.
   *
   * Seeding here rather than leaving it to the pricing pass is what keeps the
   * feed live: a curve with no reserves recorded cannot have trade events
   * applied to it, so it would show a market cap only as fresh as its turn in
   * a 90-per-pass rotation. Seeded at birth, it is carried forward exactly by
   * events from its first trade onward.
   */
  const PER = 9;
  const meta = await c.multicall({
    contracts: add.flatMap((x) => [
      { address: x.token, abi: erc20Abi, functionName: "symbol" as const },
      { address: x.token, abi: erc20Abi, functionName: "name" as const },
      { address: x.token, abi: erc20Abi, functionName: "logo" as const },
      { address: x.pairToken, abi: erc20Abi, functionName: "symbol" as const },
      { address: x.pairToken, abi: erc20Abi, functionName: "decimals" as const },
      { address: x.curve, abi: bondingCurveAbi, functionName: "getReserves" as const },
      { address: x.curve, abi: bondingCurveAbi, functionName: "realQuoteReserve" as const },
      // Appended rather than inserted: the reserve reads above are addressed
      // by index, and shifting them would silently mis-seed every curve.
      { address: x.token, abi: erc20Abi, functionName: "socials" as const },
      { address: x.token, abi: erc20Abi, functionName: "description" as const },
    ]),
    allowFailure: true,
    blockNumber: head,
  });

  const ins = db().prepare(
    `INSERT OR IGNORE INTO feed_tokens
       (token, curve, deployer, symbol, name, logo, quote_token, quote_symbol,
        quote_decimals, quote_is_native, threshold, launch_block, log_index, created_at,
        quote_reserve, token_reserve, phantom, reserves_block,
        price, mcap, liquidity, progress_pct, priced_at, socials, description)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const at = new Date().toISOString();
  /** Opening price of each launch, for the first point on its chart. */
  const born: [string, number][] = [];
  for (let i = 0; i < add.length; i++) {
    const x = add[i];
    const cell = (k: number) => meta[i * PER + k];
    const str = (k: number) => (cell(k)?.status === "success" ? String(cell(k).result) : null);
    const isNative = x.pairToken.toLowerCase() === NATIVE;
    // currency0 is the zero address on native pairs, where symbol() reverts.
    const qDec = isNative ? 18 : Number(cell(4)?.status === "success" ? cell(4).result : 18);
    const rv = cell(5);
    const real = cell(6);
    let q = 0n;
    let t = 0n;
    let phantom = 0n;
    let price = 0;
    let liquidity = 0;
    if (rv?.status === "success") {
      [q, t] = rv.result as readonly [bigint, bigint];
      const realQuote = real?.status === "success" ? (real.result as bigint) : 0n;
      phantom = q > realQuote ? q - realQuote : 0n;
      liquidity = Number(realQuote) / 10 ** qDec;
      if (q > 0n && t > 0n) price = Number(q) / 10 ** qDec / (Number(t) / 1e18);
    }
    const threshold = Number(x.threshold) / 10 ** qDec;

    ins.run(
      x.token.toLowerCase(),
      x.curve.toLowerCase(),
      x.deployer.toLowerCase(),
      str(0),
      str(1),
      str(2),
      x.pairToken.toLowerCase(),
      isNative ? "ETH" : (str(3) ?? "?"),
      qDec,
      isNative ? 1 : 0,
      threshold,
      Number(x.block),
      x.logIndex,
      at,
      rv?.status === "success" ? q.toString() : null,
      rv?.status === "success" ? t.toString() : null,
      rv?.status === "success" ? phantom.toString() : null,
      rv?.status === "success" ? Number(head) : 0,
      price,
      price * (SUPPLY_RAW / 1e18),
      liquidity,
      threshold > 0 ? Math.min(100, (liquidity / threshold) * 100) : 0,
      at,
      str(7),
      str(8),
    );
    s.seen += 1;
    if (price > 0) born.push([x.curve.toLowerCase(), price]);
  }
  // A coin one second old has no trades yet, so without this its chart would
  // be empty for the whole first minute — the minute anyone is looking.
  recordPrices(born);

  // Start fetching the artwork now rather than when a browser first asks. These
  // rows will be at the top of the feed within seconds and an ipfs gateway
  // takes longer than that, so without this the newest coins -- the ones anyone
  // is actually looking at -- would always show initials.
  warmImages(add.map((_, i) => (meta[i * PER + 2]?.status === "success" ? String(meta[i * PER + 2].result) : null)));
  if (add.length) notifyFeed(add.length);
  return add.length;
}

/**
 * Every curve trade on the chain in one query.
 *
 * The events are emitted by each curve, so there is no address to filter on —
 * which is the point. Grouping the result by log.address gives per-token volume
 * for the whole market at the cost of two queries.
 */
async function sweepTrades(head: bigint): Promise<void> {
  const c = logClient();
  if (s.lastTradeBlock === 0n) {
    const saved = loadCursor("trades");
    s.lastTradeBlock = saved > 0n && head - saved < MAX_SPAN * 20n ? saved : head - 200n;
  }
  if (head <= s.lastTradeBlock) return;

  // Curves we are showing, with the exact state each was last known to be in.
  const rows = db()
    .prepare(
      `SELECT curve, quote_decimals, quote_reserve, token_reserve, phantom,
              reserves_block, threshold
         FROM feed_tokens WHERE graduated = 0`,
    )
    .all() as {
    curve: string;
    quote_decimals: number;
    quote_reserve: string | null;
    token_reserve: string | null;
    phantom: string | null;
    reserves_block: number;
    threshold: number | null;
  }[];
  const meta = new Map(rows.map((r) => [r.curve, r]));
  if (!meta.size) {
    s.lastTradeBlock = head;
    return;
  }

  const bucket = nowBucket();
  const agg = new Map<string, { quote: number; buys: number; sells: number }>();
  /** Curves whose reserves this pass advanced, and to which block. */
  const moved = new Map<string, { q: bigint; t: bigint; block: number }>();
  /** Token deltas per (curve, wallet) this pass, summed before writing. */
  const deltas = new Map<string, number>();
  /** (curve|wallet) -> block of that wallet's first buy seen this sweep. */
  const firstBuy = new Map<string, number>();

  const add = (curve: string, raw: bigint, isBuy: boolean) => {
    const m = meta.get(curve);
    if (!m) return;
    const cur = agg.get(curve) ?? { quote: 0, buys: 0, sells: 0 };
    cur.quote += Number(raw) / 10 ** (m.quote_decimals ?? 18);
    if (isBuy) cur.buys += 1;
    else cur.sells += 1;
    agg.set(curve, cur);
  };

  /**
   * Advance a curve's reserves by one trade.
   *
   * Verified against the chain rather than derived from the contract: polling
   * reserves, replaying every event over the next 45 seconds and re-polling
   * reproduced both sides to the wei across 232 trades. That is what lets the
   * feed price 2,000+ curves live without a read each — the events already in
   * hand carry the whole state transition.
   */
  const applyTrade = (
    curve: string,
    block: number,
    ev: { quoteIn?: bigint; tokensOut?: bigint; tokensIn?: bigint; quoteOut?: bigint; fee: bigint; tax: bigint },
    isBuy: boolean,
  ) => {
    const m = meta.get(curve);
    if (!m || m.quote_reserve == null || m.token_reserve == null) return;
    // Anything at or before the polled block is already in those reserves.
    if (block <= (m.reserves_block ?? 0)) return;

    const held = moved.get(curve);
    let q = held ? held.q : BigInt(m.quote_reserve);
    let t = held ? held.t : BigInt(m.token_reserve);
    if (isBuy) {
      q += (ev.quoteIn ?? 0n) - ev.fee - ev.tax;
      t -= ev.tokensOut ?? 0n;
    } else {
      t += ev.tokensIn ?? 0n;
      q -= (ev.quoteOut ?? 0n) + ev.fee + ev.tax;
    }
    moved.set(curve, { q, t, block });
  };

  let cursor = s.lastTradeBlock;
  for (let i = 0; i < TRADE_MAX_CHUNKS && cursor < head; i++) {
    const from = cursor + 1n;
    const to = head - from > TRADE_CHUNK ? from + TRADE_CHUNK : head;
    // Both events in a single query rather than one each. Halving the request
    // count matters here: the public node intermittently refuses under burst,
    // and this stage was the one failing.
    const found = await c.getLogs({ events: [BUY_EVENT, SELL_EVENT], fromBlock: from, toBlock: to });
    // getLogs returns ascending, and the chunks run in order, so trades reach
    // applyTrade in the sequence the chain executed them.
    for (const l of found) {
      const curve = String(l.address).toLowerCase();
      const isBuy = l.eventName === "CurveBuy";
      const a = l.args as {
        quoteIn?: bigint;
        tokensOut?: bigint;
        tokensIn?: bigint;
        quoteOut?: bigint;
        fee: bigint;
        tax: bigint;
      };
      add(curve, (isBuy ? a.quoteIn : a.quoteOut) ?? 0n, isBuy);
      applyTrade(curve, Number(l.blockNumber ?? 0n), a, isBuy);
      if (meta.has(curve)) {
        // Buys credit the buyer, sells debit the seller. Tokens are always 18
        // decimals here, unlike the quote side.
        const who = String(
          (isBuy ? (l.args as { buyer?: string }).buyer : (l.args as { seller?: string }).seller) ?? "",
        ).toLowerCase();
        if (who) {
          const amt = Number((isBuy ? a.tokensOut : a.tokensIn) ?? 0n) / 1e18;
          const k = `${curve}|${who}`;
          deltas.set(k, (deltas.get(k) ?? 0) + (isBuy ? amt : -amt));
          // Earliest buy only. Sweeps run in ascending block order, so the
          // first one seen for a wallet is the first one there was.
          if (isBuy && !firstBuy.has(k)) firstBuy.set(k, Number(l.blockNumber ?? 0n));
        }
      }
    }
    cursor = to;
  }
  // A stall longer than the chunk budget leaves a hole. Skipping to the head
  // keeps the feed current; the alternative is falling permanently behind and
  // reporting stale volume as if it were live.
  const skipped = head - cursor > MAX_SPAN;
  s.lastTradeBlock = skipped ? head : cursor;
  saveCursor("trades", s.lastTradeBlock);

  if (skipped) {
    // Reserves are carried forward by applying every trade in order, so a hole
    // in that sequence makes them quietly wrong rather than merely old — and
    // wrong reserves are a wrong market cap, which is a wrong filter result.
    // Discard them and let the seeding pass re-read from the chain. The last
    // known price stays on screen meanwhile rather than blanking the feed.
    db()
      .prepare(`UPDATE feed_tokens SET quote_reserve=NULL, token_reserve=NULL WHERE graduated=0`)
      .run();
    logEngine("warn", `feed skipped ${head - cursor} blocks — reserves will be re-read`);
  }

  if (agg.size) {
    const up = db().prepare(
      `INSERT INTO feed_volume (curve, bucket, quote, buys, sells) VALUES (?,?,?,?,?)
         ON CONFLICT(curve, bucket) DO UPDATE SET
           quote = quote + excluded.quote,
           buys  = buys  + excluded.buys,
           sells = sells + excluded.sells`,
    );
    for (const [curve, v] of agg) up.run(curve, bucket, v.quote, v.buys, v.sells);
  }

  if (deltas.size) {
    const up = db().prepare(
      `INSERT INTO feed_positions (curve, wallet, net, first_block) VALUES (?,?,?,?)
         ON CONFLICT(curve, wallet) DO UPDATE SET
           net = net + excluded.net,
           -- Never moves later. A wallet that buys again must not lose the
           -- entry that made it a sniper.
           first_block = MIN(COALESCE(first_block, excluded.first_block), COALESCE(excluded.first_block, first_block))`,
    );
    for (const [k, amt] of deltas) {
      const [curve, wallet] = k.split("|");
      up.run(curve, wallet, amt, firstBuy.get(k) ?? null);
    }
  }

  // Write the advanced reserves back, with the price and market cap they imply.
  if (moved.size) {
    const upd = db().prepare(
      `UPDATE feed_tokens
          SET quote_reserve=?, token_reserve=?, reserves_block=?,
              price=?, mcap=?, liquidity=?, progress_pct=?, priced_at=?
        WHERE curve=?`,
    );
    const at = new Date().toISOString();
    /** Every price this pass produced, written to history in one go after. */
    const marks: [string, number][] = [];
    for (const [curve, v] of moved) {
      const m = meta.get(curve);
      if (!m) continue;
      const qDec = m.quote_decimals ?? 18;
      const quote = Number(v.q) / 10 ** qDec;
      const token = Number(v.t) / 1e18;
      const price = token > 0 && quote > 0 ? quote / token : 0;
      const phantom = m.phantom ? Number(BigInt(m.phantom)) / 10 ** qDec : 0;
      const liquidity = Math.max(0, quote - phantom);
      const threshold = m.threshold ?? 0;
      upd.run(
        v.q.toString(),
        v.t.toString(),
        v.block,
        price,
        price * (SUPPLY_RAW / 1e18),
        liquidity,
        threshold > 0 ? Math.min(100, (liquidity / threshold) * 100) : 0,
        at,
        curve,
      );
      marks.push([curve, price]);
    }
    recordPrices(marks);
  }
}

/**
 * Seed reserves for curves that have none, and re-check a few that do.
 *
 * Once a curve is seeded the trade sweep carries it forward exactly, so this is
 * no longer how prices stay current — it is how they start, and how they are
 * repaired. A poll is still needed for: a token that has just launched, a curve
 * whose events were missed while the sweep was behind, and spotting graduation,
 * which ends the curve without emitting a trade.
 *
 * Unseeded curves come first because until one is seeded it has no price at all.
 */
async function sweepPrices(head: bigint): Promise<void> {
  const rows = db()
    .prepare(
      `SELECT token, curve, quote_decimals, threshold, quote_reserve
         FROM feed_tokens
        WHERE graduated = 0
        ORDER BY (quote_reserve IS NOT NULL) ASC, COALESCE(priced_at, '') ASC
        LIMIT ?`,
    )
    .all(PRICE_BATCH) as {
    token: string;
    curve: string;
    quote_decimals: number;
    threshold: number | null;
    quote_reserve: string | null;
  }[];
  if (!rows.length) return;

  // Pin the read to one block so the reserves and the block they are true as of
  // cannot disagree — the trade sweep uses that block to decide which events
  // are already baked in, and an off-by-one there double-counts a trade.
  const at = head;
  const res = await logClient().multicall({
    contracts: rows.flatMap((r) => [
      { address: getAddress(r.curve), abi: bondingCurveAbi, functionName: "getReserves" as const },
      { address: getAddress(r.curve), abi: bondingCurveAbi, functionName: "realQuoteReserve" as const },
      { address: getAddress(r.curve), abi: bondingCurveAbi, functionName: "graduated" as const },
    ]),
    allowFailure: true,
    blockNumber: at,
  });

  /** Prices this pass read straight from the chain. */
  const seeded: [string, number][] = [];
  const upd = db().prepare(
    `UPDATE feed_tokens
        SET price=?, mcap=?, liquidity=?, progress_pct=?, graduated=?, priced_at=?,
            quote_reserve=?, token_reserve=?, phantom=?, reserves_block=?
      WHERE token=?`,
  );
  const now = new Date().toISOString();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rv = res[i * 3];
    const real = res[i * 3 + 1];
    const grad = res[i * 3 + 2];
    if (rv?.status !== "success") continue;

    const [q, t] = rv.result as readonly [bigint, bigint];
    const qDec = r.quote_decimals ?? 18;
    const quote = Number(q) / 10 ** qDec;
    const token = Number(t) / 1e18;
    const price = q > 0n && t > 0n ? quote / token : 0;

    // Phantom is the fixed part of the quote reserve that is not real money.
    // Taken as the difference at a single block so the two agree by
    // construction, then held constant as the reserves move.
    const realQuote = real?.status === "success" ? (real.result as bigint) : 0n;
    const phantom = q > realQuote ? q - realQuote : 0n;
    const liquidity = Number(realQuote) / 10 ** qDec;
    const graduated = grad?.status === "success" ? (grad.result as boolean) : false;
    const threshold = r.threshold ?? 0;

    upd.run(
      price,
      price * (SUPPLY_RAW / 1e18),
      liquidity,
      threshold > 0 ? Math.min(100, (liquidity / threshold) * 100) : 0,
      graduated ? 1 : 0,
      now,
      q.toString(),
      t.toString(),
      phantom.toString(),
      Number(at),
      r.token,
    );
    seeded.push([String(r.curve).toLowerCase(), price]);
  }
  recordPrices(seeded);
}

/**
 * Re-read metadata for rows that never got it.
 *
 * Tokens are inserted once, with whatever the metadata multicall returned, and
 * a call that failed was never retried — so a token whose symbol read missed
 * stayed "???" for as long as it was in the feed. Measured at 7 rows in 250,
 * three of them over ten minutes old and stuck.
 *
 * It matters past appearances: quote_decimals falls back to 18, and a quote
 * asset that actually has 6 (USDG, and every stablecoin here) would put the
 * market cap out by a factor of a million.
 */
async function repairMetadata(): Promise<void> {
  const rows = db()
    .prepare(
      /*
       * socials IS NULL means the read never happened, not that the token has
       * no link: a successful read of an empty field stores '', which is why
       * this can retry the failures forever without retrying the 30% of
       * tokens that genuinely link nothing.
       */
      `SELECT token, quote_token, quote_is_native FROM feed_tokens
        WHERE (symbol IS NULL OR symbol = '' OR symbol = '???'
               OR socials IS NULL
               OR (quote_is_native = 0 AND (quote_symbol IS NULL OR quote_symbol = '?')))
        ORDER BY created_at DESC LIMIT 40`,
    )
    .all() as { token: string; quote_token: string | null; quote_is_native: number }[];
  if (!rows.length) return;

  const PER = 7;
  const res = await logClient().multicall({
    contracts: rows.flatMap((r) => {
      const quote = getAddress((r.quote_token ?? NATIVE) as Address);
      return [
        { address: getAddress(r.token), abi: erc20Abi, functionName: "symbol" as const },
        { address: getAddress(r.token), abi: erc20Abi, functionName: "name" as const },
        { address: getAddress(r.token), abi: erc20Abi, functionName: "logo" as const },
        { address: quote, abi: erc20Abi, functionName: "symbol" as const },
        { address: quote, abi: erc20Abi, functionName: "decimals" as const },
        { address: getAddress(r.token), abi: erc20Abi, functionName: "socials" as const },
        { address: getAddress(r.token), abi: erc20Abi, functionName: "description" as const },
      ];
    }),
    allowFailure: true,
  });

  const upd = db().prepare(
    `UPDATE feed_tokens
        SET symbol = COALESCE(?, symbol), name = COALESCE(?, name),
            logo = COALESCE(?, logo), quote_symbol = COALESCE(?, quote_symbol),
            quote_decimals = COALESCE(?, quote_decimals),
            socials = COALESCE(?, socials), description = COALESCE(?, description)
      WHERE token = ?`,
  );
  const logos: (string | null)[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cell = (k: number) => res[i * PER + k];
    const str = (k: number) => (cell(k)?.status === "success" ? String(cell(k).result) : null);
    const isNative = rows[i].quote_is_native === 1;
    const qSym = isNative ? "ETH" : str(3);
    const qDec = isNative ? 18 : cell(4)?.status === "success" ? Number(cell(4).result) : null;
    const logo = str(2);
    logos.push(logo);
    upd.run(str(0), str(1), logo, qSym, qDec, str(5), str(6), rows[i].token);
  }
  warmImages(logos);
}

/**
 * Record where a curve's price ended this minute.
 *
 * Called from every place a price is computed — the trade sweep, which is
 * where prices actually move, the pricing pass, and the launch itself so a
 * brand-new coin has a first point rather than an empty chart.
 */
function recordPrices(points: [curve: string, price: number][]): void {
  const rows = points.filter(([, p]) => Number.isFinite(p) && p > 0);
  if (!rows.length) return;
  try {
    const up = db().prepare(
      `INSERT INTO feed_prices (curve, bucket, price) VALUES (?,?,?)
         ON CONFLICT(curve, bucket) DO UPDATE SET price = excluded.price`,
    );
    // Plain loop, like every other write in this file: node:sqlite's
    // DatabaseSync has no transaction() helper.
    const tick = db().prepare(
      `INSERT INTO feed_ticks (curve, bucket, price) VALUES (?,?,?)
         ON CONFLICT(curve, bucket) DO UPDATE SET price = excluded.price`,
    );
    const b = nowBucket();
    const t = nowTick();
    for (const [curve, price] of rows) {
      up.run(curve, b, price);
      tick.run(curve, t, price);
    }
  } catch {
    /* history is decoration; never let it break a sweep */
  }
}

/*
 * Subscribers waiting to be told a launch landed.
 *
 * The browser used to poll every two seconds, which put up to two seconds
 * between a coin being indexed in 0.09s and appearing on screen — most of the
 * latency in the whole path, and all of it after the hard part was done.
 * Pushing instead means the wait is a fetch, not a poll interval.
 *
 * globalThis-backed for the usual reason: route handlers and the sweep are
 * separate module registries in Next, and a Set that each of them has its own
 * copy of would never deliver anything.
 */
const fg = globalThis as typeof globalThis & { __ponsFeedSubs?: Set<(n: number) => void> };

export function feedSubscribers(): Set<(n: number) => void> {
  fg.__ponsFeedSubs ??= new Set();
  return fg.__ponsFeedSubs;
}

/** Tell every open feed that `n` launches just landed. Never throws. */
function notifyFeed(n: number): void {
  for (const fn of feedSubscribers()) {
    try {
      fn(n);
    } catch {
      // A dead connection must not take the sweep down with it.
    }
  }
}

/** Drop what has scrolled out of the window so the tables stay small. */
function prune(): void {
  const cutoff = new Date(Date.now() - KEEP_MINUTES * 60_000).toISOString();
  db().prepare(`DELETE FROM feed_tokens WHERE created_at < ?`).run(cutoff);
  db().prepare(`DELETE FROM feed_volume WHERE bucket < ?`).run(nowBucket() - KEEP_MINUTES);
  db().prepare(`DELETE FROM feed_prices WHERE bucket < ?`).run(nowBucket() - PRICE_KEEP_MINUTES);
  db()
    .prepare(`DELETE FROM feed_ticks WHERE bucket < ?`)
    .run(nowTick() - (TICK_KEEP_HOURS * 3600) / TICK_SECONDS);
  /*
   * Orphans go too. Price rows outlive the feed window on purpose, but a curve
   * that has dropped out of feed_tokens entirely is never drawn again, so its
   * history is dead weight — without this the longer retention would keep
   * every curve seen in the last twelve hours instead of the ones still shown.
   */
  db()
    .prepare(`DELETE FROM feed_prices WHERE curve NOT IN (SELECT curve FROM feed_tokens)`)
    .run();
  db()
    .prepare(`DELETE FROM feed_ticks WHERE curve NOT IN (SELECT curve FROM feed_tokens)`)
    .run();
  db()
    .prepare(`DELETE FROM feed_positions WHERE curve NOT IN (SELECT curve FROM feed_tokens)`)
    .run();
}

/**
 * Runs one stage, naming it if it fails.
 *
 * The three stages fail for different reasons and want different fixes — an
 * oversized log range, a multicall with too many calls in it, a node hiccup —
 * and a bare "sweep failed" gave no way to tell them apart. A stage that fails
 * does not stop the others: stale volume is better than no launches.
 */
async function stage(name: string, run: () => Promise<void>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (err) {
    s.lastError = `${name}: ${redactRpc(err instanceof Error ? err.message : String(err)).split(/\r?\n/)[0].slice(0, 160)}`;
    logEngine("warn", `feed ${s.lastError}`);
    return false;
  }
}

async function sweep(): Promise<void> {
  if (!s.running || s.busy) return;
  s.busy = true;
  try {
    migrate();
    const head = await logClient().getBlockNumber();
    const ok = [await stage("launches", () => sweepLaunches(head))];
    // Trades and prices are the expensive half; a new coin does not need them
    // to appear in the list, only to have numbers next to it a moment later.
    if (s.sweeps % HEAVY_EVERY === 0) {
      ok.push(await stage("trades", () => sweepTrades(head)));
      ok.push(await stage("prices", () => sweepPrices(head)));
      ok.push(await stage("metadata", () => repairMetadata()));
    }
    if (s.sweeps % 300 === 0) prune();
    s.sweeps += 1;
    if (ok.every(Boolean)) s.lastError = null;
  } catch (err) {
    s.lastError = `head: ${redactRpc(err instanceof Error ? err.message : String(err)).split(/\r?\n/)[0].slice(0, 160)}`;
    logEngine("warn", `feed ${s.lastError}`);
  } finally {
    s.busy = false;
  }
}

export function startFeed(): void {
  if (s.running) return;
  s.running = true;
  try {
    migrate();
  } catch (err) {
    logEngine("error", `feed migrate failed: ${String(err)}`);
  }
  s.timer = setInterval(() => void sweep(), POLL_MS);
  if (s.timer && typeof s.timer === "object" && "unref" in s.timer) s.timer.unref();
  void sweep();
  logEngine("info", "new-coins feed started");
}

export function stopFeed(): void {
  s.running = false;
  if (s.timer) clearInterval(s.timer);
  s.timer = undefined;
}

export function feedStatus() {
  return {
    running: s.running,
    sweeps: s.sweeps,
    seen: s.seen,
    lastError: s.lastError,
  };
}
