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
import { createPublicClient, http, parseAbiItem, getAddress, type Address, type PublicClient } from "viem";
import { robinhoodChain, redactRpc } from "../chain";
import { db, logEngine } from "../db/index";
import { PONS } from "../pons/addresses";
import { ponsFactoryAbi, erc20Abi, bondingCurveAbi } from "../pons/abis";

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
const LOGS_RPC = process.env.LOGS_RPC_URL?.trim() || "https://rpc.mainnet.chain.robinhood.com";
let logs: PublicClient | undefined;
function logClient(): PublicClient {
  if (logs) return logs;
  logs = createPublicClient({
    chain: robinhoodChain,
    transport: http(LOGS_RPC, { retryCount: 2, timeout: 25_000, batch: true }),
  }) as PublicClient;
  return logs;
}

/** How often to sweep. Launches arrive every few seconds. */
const POLL_MS = 10_000;
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
      priced_at       TEXT
    );
  `);
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
}

const nowBucket = () => Math.floor(Date.now() / 60_000);

/** New launches -> feed rows, with the metadata the list needs to render. */
async function sweepLaunches(head: bigint): Promise<void> {
  const c = logClient();
  if (s.lastLaunchBlock === 0n) s.lastLaunchBlock = head - 600n;
  let from = s.lastLaunchBlock + 1n;
  if (head < from) return;
  if (head - from > MAX_SPAN) from = head - MAX_SPAN;

  const found = await c.getLogs({ address: PONS.factory, event: LAUNCH_EVENT, fromBlock: from, toBlock: head });
  s.lastLaunchBlock = head;
  if (!found.length) return;

  const fresh = found
    .map((l) => ({
      token: getAddress(String(l.args.token)),
      curve: getAddress(String(l.args.curve)),
      deployer: getAddress(String(l.args.deployer)),
      pairToken: getAddress(String(l.args.pairToken)),
      threshold: l.args.graduationThreshold as bigint,
      block: l.blockNumber ?? 0n,
    }))
    .filter((x) => x.token && x.curve);
  if (!fresh.length) return;

  const known = new Set(
    (db().prepare(`SELECT token FROM feed_tokens`).all() as { token: string }[]).map((r) => r.token),
  );
  const add = fresh.filter((x) => !known.has(x.token.toLowerCase()));
  if (!add.length) return;

  // Names, artwork and the quote asset's own symbol/decimals, in one call.
  const PER = 5;
  const meta = await c.multicall({
    contracts: add.flatMap((x) => [
      { address: x.token, abi: erc20Abi, functionName: "symbol" as const },
      { address: x.token, abi: erc20Abi, functionName: "name" as const },
      { address: x.token, abi: erc20Abi, functionName: "logo" as const },
      { address: x.pairToken, abi: erc20Abi, functionName: "symbol" as const },
      { address: x.pairToken, abi: erc20Abi, functionName: "decimals" as const },
    ]),
    allowFailure: true,
  });

  const ins = db().prepare(
    `INSERT OR IGNORE INTO feed_tokens
       (token, curve, deployer, symbol, name, logo, quote_token, quote_symbol,
        quote_decimals, quote_is_native, threshold, launch_block, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const at = new Date().toISOString();
  for (let i = 0; i < add.length; i++) {
    const x = add[i];
    const cell = (k: number) => meta[i * PER + k];
    const str = (k: number) => (cell(k)?.status === "success" ? String(cell(k).result) : null);
    const isNative = x.pairToken.toLowerCase() === NATIVE;
    // currency0 is the zero address on native pairs, where symbol() reverts.
    const qDec = isNative ? 18 : Number(cell(4)?.status === "success" ? cell(4).result : 18);
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
      Number(x.threshold) / 10 ** qDec,
      Number(x.block),
      at,
    );
    s.seen += 1;
  }
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
  if (s.lastTradeBlock === 0n) s.lastTradeBlock = head - 200n;
  if (head <= s.lastTradeBlock) return;

  // Only curves we are actually showing, and their quote decimals, so raw
  // amounts can be scaled once here rather than on every read.
  const rows = db()
    .prepare(`SELECT curve, quote_decimals FROM feed_tokens`)
    .all() as { curve: string; quote_decimals: number }[];
  const dec = new Map(rows.map((r) => [r.curve, r.quote_decimals ?? 18]));
  if (!dec.size) {
    s.lastTradeBlock = head;
    return;
  }

  const bucket = nowBucket();
  const agg = new Map<string, { quote: number; buys: number; sells: number }>();
  const add = (curve: string, raw: bigint, isBuy: boolean) => {
    const d = dec.get(curve);
    if (d === undefined) return;
    const cur = agg.get(curve) ?? { quote: 0, buys: 0, sells: 0 };
    cur.quote += Number(raw) / 10 ** d;
    if (isBuy) cur.buys += 1;
    else cur.sells += 1;
    agg.set(curve, cur);
  };

  let cursor = s.lastTradeBlock;
  for (let i = 0; i < TRADE_MAX_CHUNKS && cursor < head; i++) {
    const from = cursor + 1n;
    const to = head - from > TRADE_CHUNK ? from + TRADE_CHUNK : head;
    // Both events in a single query rather than one each. Halving the request
    // count matters here: the public node intermittently refuses under burst,
    // and this stage was the one failing.
    const found = await c.getLogs({ events: [BUY_EVENT, SELL_EVENT], fromBlock: from, toBlock: to });
    for (const l of found) {
      const a = l.args as { quoteIn?: bigint; quoteOut?: bigint };
      const isBuy = l.eventName === "CurveBuy";
      add(String(l.address).toLowerCase(), (isBuy ? a.quoteIn : a.quoteOut) ?? 0n, isBuy);
    }
    cursor = to;
  }
  // A stall longer than the chunk budget leaves a hole in the volume window.
  // Skipping to the head keeps the feed current; the alternative is falling
  // permanently behind and reporting stale volume as if it were live.
  s.lastTradeBlock = head - cursor > MAX_SPAN ? head : cursor;
  if (!agg.size) return;

  const up = db().prepare(
    `INSERT INTO feed_volume (curve, bucket, quote, buys, sells) VALUES (?,?,?,?,?)
       ON CONFLICT(curve, bucket) DO UPDATE SET
         quote = quote + excluded.quote,
         buys  = buys  + excluded.buys,
         sells = sells + excluded.sells`,
  );
  for (const [curve, v] of agg) up.run(curve, bucket, v.quote, v.buys, v.sells);
}

/** Reserves for the newest curves, and the price/mcap/liquidity that follow. */
async function sweepPrices(): Promise<void> {
  /*
   * Priority matters more than it looks. The window holds three hours of
   * launches — at ~33 a minute that is a few thousand rows — and only 90 are
   * repriced per pass, so a plain round-robin would revisit each one about
   * every ten minutes and the feed would show ten-minute-old market caps.
   *
   * Almost all of those tokens never see a second trade and can never clear a
   * filter. Ordering by recent trading puts the reprice budget on the handful
   * that are actually moving, which are exactly the rows on screen.
   */
  const since = nowBucket() - 10;
  const rows = db()
    .prepare(
      `SELECT t.token, t.curve, t.quote_decimals, t.threshold
         FROM feed_tokens t
         LEFT JOIN (
           SELECT curve, SUM(quote) AS vol FROM feed_volume WHERE bucket >= ? GROUP BY curve
         ) v ON v.curve = t.curve
        WHERE t.graduated = 0
        ORDER BY (v.vol IS NULL) ASC, COALESCE(t.priced_at, '') ASC
        LIMIT ?`,
    )
    .all(since, PRICE_BATCH) as {
    token: string;
    curve: string;
    quote_decimals: number;
    threshold: number | null;
  }[];
  if (!rows.length) return;

  const res = await logClient().multicall({
    contracts: rows.flatMap((r) => [
      { address: getAddress(r.curve), abi: bondingCurveAbi, functionName: "getReserves" as const },
      { address: getAddress(r.curve), abi: bondingCurveAbi, functionName: "realQuoteReserve" as const },
      { address: getAddress(r.curve), abi: bondingCurveAbi, functionName: "graduated" as const },
    ]),
    allowFailure: true,
  });

  const upd = db().prepare(
    `UPDATE feed_tokens SET price=?, mcap=?, liquidity=?, progress_pct=?, graduated=?, priced_at=? WHERE token=?`,
  );
  const at = new Date().toISOString();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rv = res[i * 3];
    const real = res[i * 3 + 1];
    const grad = res[i * 3 + 2];

    const qDec = r.quote_decimals ?? 18;
    let price = 0;
    if (rv?.status === "success") {
      const [q, t] = rv.result as readonly [bigint, bigint];
      // Curve reserves are (quote, token). Token side is always 18 decimals.
      if (q > 0n && t > 0n) price = (Number(q) / 10 ** qDec) / (Number(t) / 1e18);
    }
    const liquidity = real?.status === "success" ? Number(real.result as bigint) / 10 ** qDec : 0;
    const graduated = grad?.status === "success" ? (grad.result as boolean) : false;
    const mcap = price * (SUPPLY_RAW / 1e18);

    const threshold = r.threshold ?? 0;
    const progress = threshold > 0 ? Math.min(100, (liquidity / threshold) * 100) : 0;

    upd.run(price, mcap, liquidity, progress, graduated ? 1 : 0, at, r.token);
  }
}

/** Drop what has scrolled out of the window so the tables stay small. */
function prune(): void {
  const cutoff = new Date(Date.now() - KEEP_MINUTES * 60_000).toISOString();
  db().prepare(`DELETE FROM feed_tokens WHERE created_at < ?`).run(cutoff);
  db().prepare(`DELETE FROM feed_volume WHERE bucket < ?`).run(nowBucket() - KEEP_MINUTES);
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
    const ok = [
      await stage("launches", () => sweepLaunches(head)),
      await stage("trades", () => sweepTrades(head)),
      await stage("prices", () => sweepPrices()),
    ];
    if (s.sweeps % 30 === 0) prune();
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
