import { parseAbiItem, getAddress, createPublicClient, http, type Address, type PublicClient } from "viem";
import { robinhoodChain } from "../chain";
import { db, logEngine } from "../db/index";
import { PONS } from "../pons/addresses";
import { ponsFactoryAbi, erc20Abi } from "../pons/abis";

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
      pool_id       TEXT
    );
  `);
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_grad_events_id ON graduation_events(id DESC);`);
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
    const candidates: { token: Address; other: Address; pool: string; block: bigint }[] = [];
    for (const l of logs) {
      const c0 = l.args.currency0 as Address | undefined;
      const c1 = l.args.currency1 as Address | undefined;
      if (!c0 || !c1) continue;
      const block = l.blockNumber ?? 0n;
      const pool = String(l.topics[1] ?? "");
      candidates.push({ token: getAddress(c1), other: getAddress(c0), pool, block });
      candidates.push({ token: getAddress(c0), other: getAddress(c1), pool, block });
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

    // Names, artwork, and what each graduated against.
    const meta = await c.multicall({
      contracts: ours.flatMap((x) => [
        { address: x.token, abi: erc20Abi, functionName: "symbol" as const },
        { address: x.token, abi: erc20Abi, functionName: "name" as const },
        { address: x.token, abi: erc20Abi, functionName: "logo" as const },
        { address: x.other, abi: erc20Abi, functionName: "symbol" as const },
      ]),
      allowFailure: true,
    });

    migrate();
    const ins = db().prepare(
      `INSERT OR IGNORE INTO graduation_events
         (ts, block, token_address, token_symbol, token_name, logo, quote_symbol, pool_id)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    for (let i = 0; i < ours.length; i++) {
      const x = ours[i];
      const pick = (k: number) => (meta[i * 4 + k]?.status === "success" ? String(meta[i * 4 + k].result) : null);
      // currency0 is the zero address for native pools, where symbol() reverts.
      const quote =
        x.other === "0x0000000000000000000000000000000000000000" ? "ETH" : (pick(3) ?? "?");
      ins.run(
        new Date().toISOString(),
        Number(x.block),
        x.token.toLowerCase(),
        pick(0),
        pick(1),
        pick(2),
        quote,
        x.pool,
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

export function startGraduationWatcher(): void {
  if (s.running) return;
  s.running = true;
  migrate();
  void sweep();
  const t = setInterval(() => void sweep(), POLL_MS);
  if (t && typeof t === "object" && "unref" in t) t.unref();
  s.timer = t;
  logEngine("info", `graduation watcher started (v4 PoolManager ${POOL_MANAGER.slice(0, 10)}…)`);
}

export function stopGraduationWatcher(): void {
  if (s.timer) clearInterval(s.timer);
  s.timer = undefined;
  s.running = false;
}
