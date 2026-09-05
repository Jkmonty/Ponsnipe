/**
 * What happens to a pons token AFTER it graduates, over hours rather than minutes.
 *
 *   npm run poolscan
 *   npm run poolscan -- --days 4 --horizon 12 --rps 2
 *
 * Every dip and graduation test in this project ran on the bonding curve, which
 * tops out at 4.2 ETH — about $60k. So the entire range Jake actually watches,
 * $100k into the millions, happens AFTER graduation in a Uniswap v4 pool and has
 * never been measured beyond a five-minute window. A 30% dip on a $500k pooled
 * token, with two-sided liquidity and real order flow, is a different animal
 * from a 30% dip on a $5k curve, and the dip work may simply have been run on
 * the wrong asset.
 *
 * SAMPLED, not exhaustive. The v4 PoolManager is a singleton carrying every
 * pool on the chain at ~10 logs a block, so fetching every swap over a 12-hour
 * horizon for a thousand pools is impossible — it breaks the node's 10k-log
 * cap, viem's 10MB body limit, and the query timeout in turn. Instead this
 * takes a short slice of blocks at regular intervals, which yields a price
 * every SAMPLE_MINUTES for every pons pool alive in the window. That is plenty
 * to see a drawdown and a recovery at hour scale, and it costs a few hundred
 * requests rather than tens of thousands.
 *
 * Reads only. Nothing is signed.
 */
try {
  process.loadEnvFile?.(".env");
} catch {
  /* ignore */
}

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { createPublicClient, http, parseAbiItem, parseEventLogs, type Address } from "viem";
import { robinhoodChain } from "../src/lib/chain";
import { ponsFactoryAbi } from "../src/lib/pons/abis";
import { PONS } from "../src/lib/pons/addresses";

/** Log queries must not use Alchemy: its free tier caps eth_getLogs at 10 blocks. */
const RPC = process.env.LOGS_RPC_URL?.trim() || "https://rpc.mainnet.chain.robinhood.com";
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address;
const OUT = "./data/pools.sqlite";

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1]);
    if (Number.isFinite(n)) return n;
  }
  return dflt;
}
const DAYS = arg("days", 4);
/** How long to follow each pool after it opens. */
const HORIZON_H = arg("horizon", 12);
const RPS = arg("rps", 2);
/** Blocks per price sample. A slice this size sees ~40s of trading. */
const SLICE = 400n;
/** How often to take one. */
const SAMPLE_MINUTES = arg("sample", 15);
const INIT_CHUNK = 20_000n;
const VERIFY_BATCH = 300;

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(RPC, { retryCount: 2, timeout: 25_000 }),
});
const INITIALIZE = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
);
const SWAP = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MIN_INTERVAL = 1000 / Math.max(0.5, RPS);
let lastCall = 0;
let requests = 0;
async function rpc<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const wait = MIN_INTERVAL - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    requests++;
    try {
      return await fn();
    } catch (e) {
      const s = String(e);
      const retry =
        s.includes("429") ||
        s.includes("403") ||
        /too many requests|cf-mitigated|timed out|timeout|exceeds limit|more than|body exceeded/i.test(s);
      if (!retry || attempt >= 9) throw e;
      await sleep(Math.min(90_000, 2_000 * 2 ** Math.min(attempt, 5)));
    }
  }
}

const Q96 = 2 ** 96;

interface Pool {
  id: string;
  token: string;
  /** True when the pons token is currency1, so its price is the reciprocal. */
  tokenIsC1: boolean;
  quote: string;
  openBlock: bigint;
  openSqrt: number;
  /** Sampled price as a multiple of the opening price, in time order. */
  path: { block: bigint; mult: number }[];
}

/**
 * sqrtPriceX96 encodes currency1 per currency0. Which side our token sits on
 * decides whether its price is that ratio or its reciprocal, and getting it
 * backwards would turn every pump into a dump.
 */
function priceOf(p: Pool, sqrt: number): number {
  if (sqrt <= 0 || p.openSqrt <= 0) return 0;
  const r = p.tokenIsC1 ? p.openSqrt / sqrt : sqrt / p.openSqrt;
  return r * r;
}

function pct(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.floor(q * (s.length - 1))))];
}
const asPct = (m: number) => ((m - 1) * 100).toFixed(1) + "%";

async function main() {
  const head = await rpc(() => client.getBlockNumber());
  const hb = await rpc(() => client.getBlock({ blockNumber: head }));
  const pb = await rpc(() => client.getBlock({ blockNumber: head - 50_000n }));
  const blockSecs = Number(hb.timestamp - pb.timestamp) / 50_000;

  const horizonBlocks = BigInt(Math.round((HORIZON_H * 3600) / blockSecs));
  const spanBlocks = BigInt(Math.round((DAYS * 86400) / blockSecs));
  const start = head - spanBlocks;
  const step = BigInt(Math.round((SAMPLE_MINUTES * 60) / blockSecs));

  console.log(`\npost-graduation pool scan — ${DAYS} days of graduations, ${HORIZON_H}h each`);
  console.log(`blocks ${start} → ${head}, sampling ${SLICE} blocks every ${SAMPLE_MINUTES} min`);
  console.log(`(the curve tops out near $60k; everything above that lives here)\n`);

  // ── pass 1: pools opened in the window, verified as pons graduations ───────
  const candidates: { id: string; c0: string; c1: string; block: bigint; sqrt: number }[] = [];
  for (let from = start; from <= head; from += INIT_CHUNK) {
    const to = from + INIT_CHUNK - 1n > head ? head : from + INIT_CHUNK - 1n;
    const logs = await rpc(() =>
      client.getLogs({ address: POOL_MANAGER, event: INITIALIZE, fromBlock: from, toBlock: to }),
    );
    for (const l of logs) {
      const a = l.args as unknown as Record<string, string | bigint>;
      const sqrt = Number(a.sqrtPriceX96 as bigint) / Q96;
      if (sqrt <= 0) continue;
      candidates.push({
        id: String(l.topics[1] ?? ""),
        c0: String(a.currency0).toLowerCase(),
        c1: String(a.currency1).toLowerCase(),
        block: l.blockNumber ?? 0n,
        sqrt,
      });
    }
    process.stdout.write(`\r  pass 1: ${candidates.length} pools opened  (${requests} req)   `);
  }
  console.log("");

  // The singleton carries every pool on the chain, so ask the factory which
  // side — if either — is one of ours.
  const pools: Pool[] = [];
  const flat: { cand: (typeof candidates)[number]; token: string; other: string; isC1: boolean }[] = [];
  for (const c of candidates) {
    flat.push({ cand: c, token: c.c1, other: c.c0, isC1: true });
    flat.push({ cand: c, token: c.c0, other: c.c1, isC1: false });
  }
  const claimed = new Set<string>();
  for (let i = 0; i < flat.length; i += VERIFY_BATCH) {
    const slice = flat.slice(i, i + VERIFY_BATCH);
    const res = await rpc(() =>
      client.multicall({
        contracts: slice.map((x) => ({
          address: PONS.factory,
          abi: ponsFactoryAbi,
          functionName: "getLaunchedToken" as const,
          args: [x.token as Address],
        })),
        allowFailure: true,
      }),
    );
    for (let k = 0; k < slice.length; k++) {
      const r = res[k];
      if (r.status !== "success") continue;
      const info = r.result as unknown as { exists: boolean };
      if (!info?.exists) continue;
      const x = slice[k];
      if (claimed.has(x.cand.id)) continue;
      claimed.add(x.cand.id);
      // Only pools with a full horizon ahead of them inside chain history.
      if (x.cand.block + horizonBlocks > head) continue;
      pools.push({
        id: x.cand.id,
        token: x.token,
        tokenIsC1: x.isC1,
        quote: x.other,
        openBlock: x.cand.block,
        openSqrt: x.cand.sqrt,
        path: [],
      });
    }
    process.stdout.write(`\r  verify: ${pools.length} pons pools of ${Math.min(i + VERIFY_BATCH, flat.length)} checked  (${requests} req)   `);
  }
  console.log("");
  if (!pools.length) {
    console.log("\nNo pons graduations with a full horizon in this window.\n");
    return;
  }

  // ── pass 2: sample the price everywhere, assign to whichever pool owns it ──
  const byId = new Map(pools.map((p) => [p.id.toLowerCase(), p]));
  let swaps = 0;
  const sampleEnd = head;
  let slices = 0;
  for (let at = start; at <= sampleEnd; at += step) {
    const to = at + SLICE - 1n > sampleEnd ? sampleEnd : at + SLICE - 1n;
    const logs = await rpc(() =>
      client.getLogs({ address: POOL_MANAGER, event: SWAP, fromBlock: at, toBlock: to }),
    );
    slices++;
    for (const l of logs) {
      const p = byId.get(String(l.topics[1] ?? "").toLowerCase());
      if (!p) continue;
      const age = (l.blockNumber ?? 0n) - p.openBlock;
      if (age < 0n || age > horizonBlocks) continue;
      const a = l.args as unknown as Record<string, bigint>;
      const mult = priceOf(p, Number(a.sqrtPriceX96) / Q96);
      if (mult <= 0) continue;
      swaps++;
      // One sample per slice per pool is enough; keep the last.
      const last = p.path[p.path.length - 1];
      if (last && last.block === (l.blockNumber ?? 0n)) last.mult = mult;
      else p.path.push({ block: l.blockNumber ?? 0n, mult });
    }
    if (slices % 10 === 0) {
      const done = Number(at - start) / Number(spanBlocks);
      process.stdout.write(`\r  pass 2: ${(done * 100).toFixed(0)}%  ${swaps} samples  (${requests} req)   `);
    }
  }
  console.log("\n");

  const traded = pools.filter((p) => p.path.length >= 2);
  console.log(`${pools.length} pons pools with a full ${HORIZON_H}h ahead of them`);
  console.log(`${traded.length} of them show at least two price samples\n`);
  if (traded.length < 20) {
    console.log("Too few to say anything. Widen --days or shorten --horizon.\n");
    return;
  }

  // ── where does a graduated token actually go? ──────────────────────────────
  const marks = [1, 3, 6, 12].filter((h) => h <= HORIZON_H);
  console.log(`PRICE vs the graduation price (the curve's last price, ~$60k)`);
  console.log("  after      n     p10     p25  median     p75     p90    mean");
  for (const h of marks) {
    const hb2 = BigInt(Math.round((h * 3600) / blockSecs));
    const xs: number[] = [];
    for (const p of traded) {
      // Last sample at or before the mark; a pool that stopped trading holds
      // its last price, which is what a holder would actually be sitting on.
      let v = 1;
      for (const s of p.path) {
        if (s.block - p.openBlock <= hb2) v = s.mult;
        else break;
      }
      xs.push(v);
    }
    const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
    console.log(
      `  ${(h + "h").padEnd(6)}${String(xs.length).padStart(6)}` +
        `${asPct(pct(xs, 0.1)).padStart(8)}${asPct(pct(xs, 0.25)).padStart(8)}${asPct(pct(xs, 0.5)).padStart(8)}` +
        `${asPct(pct(xs, 0.75)).padStart(8)}${asPct(pct(xs, 0.9)).padStart(8)}${asPct(mean).padStart(8)}`,
    );
  }

  // ── the dip trade, on pooled tokens this time ──────────────────────────────
  // For each pool: track the running high, and the first time price falls X%
  // below it. Then measure what happened from THAT point on — which is the
  // trade, rather than the hindsight best recovery the curve analysis measured.
  console.log(`\nBUYING A DIP IN THE POOL — first drawdown of X% off the running high`);
  console.log("  dip     n   reached+25%  +50%  +100%   median outcome   mean");
  for (const depth of [20, 30, 40, 50, 60]) {
    const outcomes: number[] = [];
    let hit25 = 0, hit50 = 0, hit100 = 0;
    for (const p of traded) {
      let high = 1;
      let entry = 0;
      let best = 0;
      let last = 1;
      for (const s of p.path) {
        if (s.mult > high) high = s.mult;
        if (!entry && high > 0 && (high - s.mult) / high >= depth / 100) {
          entry = s.mult; // first qualifying dip becomes the entry
          best = s.mult;
          continue;
        }
        if (entry) {
          if (s.mult > best) best = s.mult;
          last = s.mult;
        }
      }
      if (!entry) continue;
      const ret = last / entry;
      outcomes.push(ret);
      const peak = best / entry;
      if (peak >= 1.25) hit25++;
      if (peak >= 1.5) hit50++;
      if (peak >= 2) hit100++;
    }
    if (outcomes.length < 20) continue;
    const mean = outcomes.reduce((s, v) => s + v, 0) / outcomes.length;
    const n = outcomes.length;
    console.log(
      `  ${(depth + "%").padEnd(6)}${String(n).padStart(5)}` +
        `${((hit25 / n) * 100).toFixed(0).padStart(11)}%${((hit50 / n) * 100).toFixed(0).padStart(6)}%` +
        `${((hit100 / n) * 100).toFixed(0).padStart(7)}%` +
        `${asPct(pct(outcomes, 0.5)).padStart(17)}${asPct(mean).padStart(8)}`,
    );
  }
  console.log(`\n  "outcome" is where it sat at the end of the horizon, not its peak —`);
  console.log(`  the peak is what you could have had, the outcome is what holding gave you.`);

  // ── persist ───────────────────────────────────────────────────────────────
  try {
    mkdirSync("./data", { recursive: true });
  } catch {
    /* exists */
  }
  const db = new DatabaseSync(OUT);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    DROP TABLE IF EXISTS pools; DROP TABLE IF EXISTS path;
    CREATE TABLE pools (id TEXT PRIMARY KEY, token TEXT, quote TEXT, open_block INTEGER, samples INTEGER);
    CREATE TABLE path (id TEXT, block INTEGER, mult REAL);
    CREATE INDEX i_path ON path(id);
  `);
  const ip = db.prepare("INSERT OR REPLACE INTO pools VALUES (?,?,?,?,?)");
  const ipath = db.prepare("INSERT INTO path VALUES (?,?,?)");
  db.exec("BEGIN");
  for (const p of pools) {
    ip.run(p.id, p.token, p.quote, Number(p.openBlock), p.path.length);
    for (const s of p.path) ipath.run(p.id, Number(s.block), s.mult);
  }
  db.exec("COMMIT");
  console.log(`\nwritten to ${OUT} — ${requests} RPC requests\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
