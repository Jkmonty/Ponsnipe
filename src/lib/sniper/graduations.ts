import { parseAbiItem, getAddress, createPublicClient, http, type Address, type PublicClient } from "viem";
import { robinhoodChain } from "../chain";
import { db, logEngine } from "../db/index";
import { PONS } from "../pons/addresses";
import { ponsFactoryAbi, erc20Abi } from "../pons/abis";

/**
 * Market cap without a price oracle, straight from the pool price.
 *
 * sqrtPriceX96 gives currency1 per currency0 in raw units, so the token's price
 * in quote terms is that ratio or its reciprocal depending which side it sits
 * on, and market cap is simply supply times price.
 *
 * The tidier-looking route — every pons pool opens seeded with 10/49 of supply
 * against the full threshold, so opening cap should be threshold*4.9 — turned
 * out to disagree with the pool itself on non-ETH quotes, giving 2.058e13 USDG
 * for tokens whose own opening price says ~37k. The pool price is the thing we
 * can verify, so it wins.
 */
const SUPPLY_RAW = 1e27;

function mcapFromSqrt(sqrt: number, tokenIsC1: boolean, quoteDecimals: number): number {
  if (!(sqrt > 0)) return 0;
  const quotePerToken = tokenIsC1 ? 1 / (sqrt * sqrt) : sqrt * sqrt;
  const raw = SUPPLY_RAW * quotePerToken;
  const mc = raw / 10 ** quoteDecimals;
  return Number.isFinite(mc) && mc > 0 ? mc : 0;
}

/**
 * Watches tokens migrating off their bonding curve into a Uniswap v4 pool.
 *
 * pons graduates a token by seeding a pool on the v4 singleton PoolManager, so
 * an Initialize event there is the moment of migration. The PoolManager is
 * shared with every other pool on the chain, though — the last full scan found
 * 4,706 native-ETH pools opening in 17h against a few hundred pons graduations
 * — so each candidate is checked against the factory before it is kept.
 *
 * This is the other half of the launch feed: what has already made it.
 */

const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address;
/**
 * Declared as a typed event rather than a raw topic hash: the app talks to the
 * node over a WebSocket, and a hand-rolled client.request({method:"eth_getLogs"})
 * is rejected there ("JSON is not a valid request object") even though it works
 * fine over HTTP. viem's getLogs builds the right frame for either transport.
 */
const SWAP_EVENT = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);
const INITIALIZE_EVENT = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
);
/**
 * Log queries deliberately use their OWN endpoint, not the app's RPC.
 *
 * Two reasons, both learned the hard way. The provider's WebSocket accepts
 * subscriptions but rejects eth_getLogs outright ("JSON is not a valid request
 * object"). And Alchemy's free tier caps eth_getLogs at 10 blocks, so a sweep
 * of thousands cannot run there at all — the public endpoint allows 2000+.
 *
 * Migrations are rare and this polls every few seconds, so the public node's
 * higher latency costs nothing here. Override with LOGS_RPC_URL.
 */
const LOGS_RPC = process.env.LOGS_RPC_URL?.trim() || "https://rpc.mainnet.chain.robinhood.com";
let httpClient: PublicClient | undefined;
function logClient(): PublicClient {
  if (httpClient) return httpClient;
  httpClient = createPublicClient({
    chain: robinhoodChain,
    transport: http(LOGS_RPC, { retryCount: 2, timeout: 20_000 }),
  }) as PublicClient;
  return httpClient;
}

/** How often to sweep for new pools. Migrations are rare; this is not a race. */
const POLL_MS = 12_000;
/** Never look further back than this on a single sweep. */
const MAX_LOOKBACK = 40_000n;
/** Window for market cap and volume — ~30 min of trading at 0.101s blocks. */
const STATS_LOOKBACK = 18_000n;

interface GradState {
  running: boolean;
  timer: ReturnType<typeof setInterval> | undefined;
  lastBlock: bigint;
  seen: Set<string>;
  found: number;
  checked: number;
  lastError: string | null;
}

// globalThis-backed for the same reason as the sniper: instrumentation and the
// route handlers are separate module registries.
const g = globalThis as typeof globalThis & { __ponsGrads?: GradState };
const s: GradState =
  g.__ponsGrads ??
  (g.__ponsGrads = {
    running: false,
    timer: undefined,
    lastBlock: 0n,
    seen: new Set(),
    found: 0,
    checked: 0,
    lastError: null,
  });

function migrate(): void {
  const conn = db();
  conn.exec(`
    CREATE TABLE IF NOT EXISTS graduation_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            TEXT NOT NULL,
      block         INTEGER NOT NULL,
      token_address TEXT NOT NULL UNIQUE,
      token_symbol  TEXT,
      token_name    TEXT,
      logo          TEXT,
      quote_symbol  TEXT,
      pool_id       TEXT,
      -- token side of the pair, so a price can be read the right way up
      token_is_c1   INTEGER,
      open_sqrt     REAL,
      -- market cap in QUOTE units at the moment the pool opened
      open_mcap     REAL,
      -- refreshed as the pool trades
      last_mult     REAL,
      mcap          REAL,
      volume        REAL,
      txs           INTEGER,
      stats_at      TEXT,
      quote_decimals INTEGER
    );
  `);
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_grad_events_id ON graduation_events(id DESC);`);

  // CREATE TABLE IF NOT EXISTS will not add columns to a table that already
  // exists, so anything added after the first release has to be bolted on.
  for (const [col, decl] of [
    ["token_is_c1", "INTEGER"],
    ["open_sqrt", "REAL"],
    ["open_mcap", "REAL"],
    ["last_mult", "REAL"],
    ["mcap", "REAL"],
    ["volume", "REAL"],
    ["txs", "INTEGER"],
    ["stats_at", "TEXT"],
    ["quote_decimals", "INTEGER"],
  ] as const) {
    try {
      conn.exec(`ALTER TABLE graduation_events ADD COLUMN ${col} ${decl};`);
    } catch {
      /* already present */
    }
  }
}

export interface GraduationRow {
  id: number;
  ts: string;
  block: number;
  token_address: string;
  token_symbol: string | null;
  token_name: string | null;
  logo: string | null;
  quote_symbol: string | null;
  pool_id: string | null;
  /** Market cap at open, in quote units. */
  open_mcap: number | null;
  /** Current price as a multiple of the opening price. */
  last_mult: number | null;
  /** Current market cap, quote units. */
  mcap: number | null;
  /** Quote-side volume over the stats window. */
  volume: number | null;
  txs: number | null;
  stats_at: string | null;
}

export function recentGraduations(limit = 40): GraduationRow[] {
  try {
    migrate();
    return db()
      .prepare(`SELECT * FROM graduation_events ORDER BY id DESC LIMIT ?`)
      .all(Math.max(1, Math.min(200, limit))) as unknown as GraduationRow[];
  } catch {
    return [];
  }
}

export function graduationStatus() {
  return {
    running: s.running,
    lastBlock: Number(s.lastBlock),
    found: s.found,
    checked: s.checked,
    lastError: s.lastError,
  };
}

/** Strip any URL so an API key can never reach the UI through an error. */
function redact(msg: string): string {
  return msg.replace(/https?:\/\/\S+|wss?:\/\/\S+/gi, "<rpc>");
}

async function sweep(): Promise<void> {
  const c = logClient();
  try {
    const head = await c.getBlockNumber();
    // Seed with ~30 min of history so the panel has something in it immediately;
    // graduations are rare enough that a short lookback shows an empty list.
    if (s.lastBlock === 0n) s.lastBlock = head - 18_000n;
    let from = s.lastBlock + 1n;
    if (head < from) return;
    // A long stall must not turn into one enormous query.
    if (head - from > MAX_LOOKBACK) from = head - MAX_LOOKBACK;

    const logs = await c.getLogs({
      address: POOL_MANAGER,
      event: INITIALIZE_EVENT,
      fromBlock: from,
      toBlock: head,
    });
    s.lastBlock = head;
    if (!logs.length) return;

    // A pons token can be either side of the pair depending on address
    // ordering, so both currencies are candidates until the factory decides.
    const candidates: { token: Address; other: Address; pool: string; block: bigint; openSqrt: number }[] = [];
    for (const l of logs) {
      const c0 = l.args.currency0 as Address | undefined;
      const c1 = l.args.currency1 as Address | undefined;
      if (!c0 || !c1) continue;
      const block = l.blockNumber ?? 0n;
      const pool = String(l.topics[1] ?? "");
      // The opening price, so later swaps can be read as a multiple of it.
      const openSqrt = Number((l.args as unknown as Record<string, bigint>).sqrtPriceX96 ?? 0n) / 2 ** 96;
      candidates.push({ token: getAddress(c1), other: getAddress(c0), pool, block, openSqrt });
      candidates.push({ token: getAddress(c0), other: getAddress(c1), pool, block, openSqrt });
    }
    const fresh = candidates.filter((x) => !s.seen.has(x.token.toLowerCase()));
    if (!fresh.length) return;

    // One multicall decides which of these are ours.
    s.checked += fresh.length;
    const res = await c.multicall({
      contracts: fresh.map((x) => ({
        address: PONS.factory,
        abi: ponsFactoryAbi,
        functionName: "getLaunchedToken" as const,
        args: [x.token],
      })),
      allowFailure: true,
    });

    const ours: typeof fresh = [];
    for (let i = 0; i < fresh.length; i++) {
      const r = res[i];
      s.seen.add(fresh[i].token.toLowerCase());
      if (r.status !== "success") continue;
      const info = r.result as unknown as { exists: boolean };
      if (info?.exists) ours.push(fresh[i]);
    }
    if (s.seen.size > 8000) s.seen = new Set([...s.seen].slice(-4000));
    if (!ours.length) return;

    // Names, artwork, what each graduated against, and the quote's decimals —
    // the threshold is in raw quote units and means nothing without them.
    const meta = await c.multicall({
      contracts: ours.flatMap((x) => [
        { address: x.token, abi: erc20Abi, functionName: "symbol" as const },
        { address: x.token, abi: erc20Abi, functionName: "name" as const },
        { address: x.token, abi: erc20Abi, functionName: "logo" as const },
        { address: x.other, abi: erc20Abi, functionName: "symbol" as const },
        { address: x.other, abi: erc20Abi, functionName: "decimals" as const },
        { address: PONS.factory, abi: ponsFactoryAbi, functionName: "getLaunchedToken" as const, args: [x.token] },
      ]),
      allowFailure: true,
    });
    const PER = 6;

    migrate();
    const ins = db().prepare(
      `INSERT OR IGNORE INTO graduation_events
         (ts, block, token_address, token_symbol, token_name, logo, quote_symbol, pool_id,
          token_is_c1, open_sqrt, open_mcap, last_mult, mcap, volume, txs, stats_at, quote_decimals)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (let i = 0; i < ours.length; i++) {
      const x = ours[i];
      const cell = (k: number) => meta[i * PER + k];
      const pick = (k: number) => (cell(k)?.status === "success" ? String(cell(k).result) : null);
      const isNative = x.other === "0x0000000000000000000000000000000000000000";
      const qDec = isNative ? 18 : Number(cell(4)?.status === "success" ? cell(4).result : 18);
      // Opening market cap, from the pool's own opening price.
      const tokenIsC1 = x.token.toLowerCase() > x.other.toLowerCase();
      const openMcap = mcapFromSqrt(x.openSqrt ?? 0, tokenIsC1, qDec);
      // currency0 is the zero address for native pools, where symbol() reverts.
      const quote = isNative ? "ETH" : (pick(3) ?? "?");
      ins.run(
        new Date().toISOString(),
        Number(x.block),
        x.token.toLowerCase(),
        pick(0),
        pick(1),
        pick(2),
        quote,
        x.pool,
        // token is currency1 when it sorts above the quote
        tokenIsC1 ? 1 : 0,
        x.openSqrt ?? 0,
        openMcap,
        1,
        openMcap,
        0,
        0,
        new Date().toISOString(),
        qDec,
      );
      s.found += 1;
      logEngine("info", `graduated ${pick(0) ?? x.token.slice(0, 10)} (${quote} pool)`);
    }
    s.lastError = null;
  } catch (e) {
    // A failed sweep is normal under RPC pressure; the next one covers the gap.
    // RPC error strings embed the endpoint URL, which carries the API key.
    s.lastError = redact(String(e)).slice(0, 200);
  }
}

/**
 * Re-price the pools already on the board.
 *
 * One filtered query covers all of them: the Swap event carries the pool id in
 * a topic, so a single getLogs over the recent window returns every trade for
 * every pool we care about and nothing else. Market cap follows from the
 * opening cap times the price move, and volume is the quote side of each swap.
 */
async function refreshStats(): Promise<void> {
  const c = logClient();
  try {
    migrate();
    const rows = db()
      .prepare(
        `SELECT token_address, pool_id, token_is_c1, open_sqrt, open_mcap, quote_symbol, quote_decimals
         FROM graduation_events ORDER BY id DESC LIMIT 60`,
      )
      .all() as unknown as {
      token_address: string;
      pool_id: string;
      token_is_c1: number;
      open_sqrt: number;
      open_mcap: number;
      quote_symbol: string;
      quote_decimals: number | null;
    }[];
    const live = rows.filter((r) => r.pool_id && r.open_sqrt > 0);
    if (!live.length) return;

    const head = await c.getBlockNumber();
    const logs = await c.getLogs({
      address: POOL_MANAGER,
      event: SWAP_EVENT,
      args: { id: live.map((r) => r.pool_id as `0x${string}`) },
      fromBlock: head - STATS_LOOKBACK,
      toBlock: head,
    });

    const byPool = new Map(live.map((r) => [r.pool_id.toLowerCase(), r]));
    const agg = new Map<string, { sqrt: number; vol: number; txs: number }>();
    for (const l of logs) {
      const key = String(l.topics[1] ?? "").toLowerCase();
      const r = byPool.get(key);
      if (!r) continue;
      const a = l.args as unknown as Record<string, bigint>;
      const sqrt = Number(a.sqrtPriceX96) / 2 ** 96;
      if (sqrt <= 0) continue;
      // The quote side of the trade is whichever currency is not the token.
      const quoteRaw = Math.abs(Number(r.token_is_c1 ? a.amount0 : a.amount1));
      const cur = agg.get(key) ?? { sqrt: 0, vol: 0, txs: 0 };
      cur.sqrt = sqrt; // logs arrive in order, so the last one is current
      cur.vol += quoteRaw;
      cur.txs += 1;
      agg.set(key, cur);
    }

    const upd = db().prepare(
      `UPDATE graduation_events SET last_mult=?, mcap=?, volume=?, txs=?, stats_at=? WHERE token_address=?`,
    );
    const now = new Date().toISOString();
    for (const r of live) {
      const a = agg.get(r.pool_id.toLowerCase());
      if (!a) continue;
      // sqrtPriceX96 is currency1 per currency0, so a token sitting on side 1
      // has the reciprocal price and its multiple inverts.
      const ratio = r.token_is_c1 ? r.open_sqrt / a.sqrt : a.sqrt / r.open_sqrt;
      const mult = ratio * ratio;
      if (!Number.isFinite(mult) || mult <= 0) continue;
      const qDec = r.quote_decimals ?? 18;
      // Cap from the live price rather than open*mult, so the two can never
      // drift apart; volume is raw quote units and needs the same scaling.
      const mcap = mcapFromSqrt(a.sqrt, r.token_is_c1 === 1, qDec);
      const vol = a.vol / 10 ** qDec;
      upd.run(mult, mcap, vol, a.txs, now, r.token_address);
    }
    s.lastError = null;
  } catch (e) {
    s.lastError = redact(String(e)).slice(0, 200);
  }
}

export function startGraduationWatcher(): void {
  if (s.running) return;
  s.running = true;
  migrate();
  void sweep().then(() => refreshStats());
  const t = setInterval(() => void sweep().then(() => refreshStats()), POLL_MS);
  if (t && typeof t === "object" && "unref" in t) t.unref();
  s.timer = t;
  logEngine("info", `graduation watcher started (v4 PoolManager ${POOL_MANAGER.slice(0, 10)}…)`);
}

export function stopGraduationWatcher(): void {
  if (s.timer) clearInterval(s.timer);
  s.timer = undefined;
  s.running = false;
}
