/**
 * What does a pons token's price DO after it migrates?
 *
 *   npm run migration
 *   npm run migration -- --hours 17 --rps 2
 *
 * Jake's observation: charts run to ~60k market cap (which is exactly the 4.2
 * ETH graduation threshold — 20.58 ETH of implied cap, ~$61.7k at $3k ETH) and
 * then "either drop, or carry on, or drop then come back". The question worth
 * money is whether the move straight after migration is systematic enough to
 * trade, because capturing it needs a Uniswap v4 sell path we have not built.
 * Measure first, build second.
 *
 * The migration is price-neutral by construction — the curve closes and the
 * pool opens at an identical 20.58 ETH per unit of supply — so anything this
 * finds is real post-migration demand, not a mechanical gap.
 *
 * TWO PASSES, because the v4 PoolManager is a singleton: one address emits the
 * events of every pool on the chain, and pulling all of them to keep the few we
 * care about moved gigabytes and died on both the node's 10k-log cap and viem's
 * 10MB body limit.
 *   1. Initialize only — sparse (a few hundred per 20k blocks), so this finds
 *      every pool that opened in the window for almost nothing.
 *   2. Swap, filtered to those pool ids via a topics[1] OR-set, so we fetch
 *      only the swaps that belong to our pools.
 * That turns ~3000 requests into ~60.
 *
 * Reads only. Nothing is signed.
 */
try {
  process.loadEnvFile?.(".env");
} catch {
  /* ignore */
}

import { createPublicClient, http, parseEventLogs, keccak256, toHex, type Address } from "viem";

const RPC = process.env.BACKTEST_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address;
/** Initialize is sparse, so pass 1 can take big bites. */
const INIT_CHUNK = 20_000n;
/** Pool ids per Swap query. Bigger batches mean more splitting, not fewer bytes. */
const BATCH = 40;

const INIT_TOPIC = keccak256(toHex("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"));
const SWAP_TOPIC = keccak256(toHex("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1]);
    if (Number.isFinite(n)) return n;
  }
  return dflt;
}
const HOURS = arg("hours", 17);
const RPS = arg("rps", 2);

const v4Abi = [
  {
    type: "event",
    name: "Initialize",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "currency0", type: "address", indexed: true },
      { name: "currency1", type: "address", indexed: true },
      { name: "fee", type: "uint24", indexed: false },
      { name: "tickSpacing", type: "int24", indexed: false },
      { name: "hooks", type: "address", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "tick", type: "int24", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Swap",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "amount0", type: "int128", indexed: false },
      { name: "amount1", type: "int128", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "liquidity", type: "uint128", indexed: false },
      { name: "tick", type: "int24", indexed: false },
      { name: "fee", type: "uint24", indexed: false },
    ],
  },
] as const;

const client = createPublicClient({ transport: http(RPC, { retryCount: 3, timeout: 60_000 }) });
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
      const rateLimited = s.includes("429") || /too many requests/i.test(s);
      const challenged = s.includes("403") || /cf-mitigated|challenge|forbidden/i.test(s);
      if ((!rateLimited && !challenged) || attempt >= 12) throw e;
      const base = challenged ? 15_000 : 1_000;
      const cap = challenged ? 180_000 : 30_000;
      await sleep(Math.min(cap, base * 2 ** Math.min(attempt, 6)));
    }
  }
}

/**
 * Fetch one block range, halving it as many times as the node demands.
 *
 * Log density is bursty, so the range cannot be sized correctly up front.
 * Splitting recursively and concatenating keeps results in block order, which
 * matters: a pool's Initialize has to be seen before its Swaps.
 */
type Hex = `0x${string}`;
async function fetchLogs(from: bigint, to: bigint, topics: (Hex | Hex[])[]): Promise<unknown[]> {
  try {
    return (await rpc(() =>
      client.request({
        method: "eth_getLogs",
        params: [
          {
            address: POOL_MANAGER,
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
            topics,
          },
        ],
      }),
    )) as unknown[];
  } catch (e) {
    // Two ceilings bite here and both mean "ask for less": the node's 10k-log
    // cap, and viem's 10MB response body limit.
    const tooBig = /exceeds limit|more than|too many logs|exceeded the size limit|body exceeded/i;
    if (to <= from || !tooBig.test(String(e))) throw e;
    const mid = from + (to - from) / 2n;
    const left = await fetchLogs(from, mid, topics);
    const right = await fetchLogs(mid + 1n, to, topics);
    return left.concat(right);
  }
}

interface Pool {
  id: string;
  token: string;
  openBlock: bigint;
  /** sqrtPriceX96 at pool open. Price ratios are taken against this. */
  openSqrt: number;
  swaps: number;
  peak: number;
  peakBlock: bigint;
  trough: number;
  /**
   * Token price at each checkpoint, as a multiple of the open. Seeded at 1 —
   * a pool with no swap yet is still sitting at exactly its opening price.
   */
  marks: number[];
}

/**
 * currency0 is native ETH (address 0 sorts first), currency1 is the token, so
 * sqrtPriceX96 encodes TOKENS per ETH. The token's price in ETH is therefore
 * the reciprocal, and a RISING sqrtPriceX96 means the token got CHEAPER.
 */
function tokenPriceMultiple(openSqrt: number, nowSqrt: number): number {
  if (nowSqrt <= 0 || openSqrt <= 0) return 0;
  const r = openSqrt / nowSqrt;
  return r * r;
}

async function main() {
  const head = await rpc(() => client.getBlockNumber());
  const hb = await rpc(() => client.getBlock({ blockNumber: head }));
  const pb = await rpc(() => client.getBlock({ blockNumber: head - 50_000n }));
  const blockSecs = Number(hb.timestamp - pb.timestamp) / 50_000;

  const CHECKPOINTS = [1, 5, 15, 30, 60];
  const cpBlocks = CHECKPOINTS.map((m) => BigInt(Math.round((m * 60) / blockSecs)));
  const MIN_FORWARD = cpBlocks[cpBlocks.length - 1];

  const spanBlocks = BigInt(Math.round((HOURS * 3600) / blockSecs));
  const start = head - spanBlocks;

  console.log(`\npost-migration price action — last ${HOURS}h`);
  console.log(`v4 PoolManager ${POOL_MANAGER}`);
  console.log(`blocks ${start} → ${head} (block time ${blockSecs.toFixed(3)}s)`);
  console.log(`checkpoints at ${CHECKPOINTS.join("/")} min after the pool opens\n`);

  // ── pass 1: every native-ETH pool that opened in the window ────────────────
  const pools: Pool[] = [];
  for (let from = start; from <= head; from += INIT_CHUNK) {
    const to = from + INIT_CHUNK - 1n > head ? head : from + INIT_CHUNK - 1n;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (await fetchLogs(from, to, [[INIT_TOPIC]])) as any[];
    for (const e of parseEventLogs({ abi: v4Abi, logs: raw })) {
      if (e.eventName !== "Initialize") continue;
      const a = e.args as unknown as Record<string, string | bigint>;
      // A token quoted in USDG or a stock token is not something we could have
      // been holding through migration anyway.
      if ((a.currency0 as string).toLowerCase() !== "0x0000000000000000000000000000000000000000") continue;
      const sq = Number(a.sqrtPriceX96 as bigint);
      if (sq <= 0) continue;
      // Only pools with a full hour ahead of them inside the chain's history.
      if (e.blockNumber! + MIN_FORWARD > head) continue;
      pools.push({
        id: e.topics[1]!.toLowerCase(),
        token: (a.currency1 as string).toLowerCase(),
        openBlock: e.blockNumber!,
        openSqrt: sq,
        swaps: 0,
        peak: 1, peakBlock: e.blockNumber!, trough: 1,
        marks: CHECKPOINTS.map(() => 1),
      });
    }
    process.stdout.write(`\r  pass 1: ${pools.length} native-ETH pools found  (${requests} requests)   `);
  }
  console.log("");
  if (!pools.length) {
    console.log("no pools with a full hour of forward data in this window\n");
    return;
  }

  // ── pass 2: only these pools' swaps ───────────────────────────────────────
  pools.sort((a, b) => (a.openBlock < b.openBlock ? -1 : 1));
  const byId = new Map(pools.map((p) => [p.id, p]));
  let swapCount = 0;

  for (let i = 0; i < pools.length; i += BATCH) {
    const batch = pools.slice(i, i + BATCH);
    const from = batch[0].openBlock;
    const to = batch[batch.length - 1].openBlock + MIN_FORWARD;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (await fetchLogs(from, to, [[SWAP_TOPIC], batch.map((p) => p.id as Hex)])) as any[];

    for (const e of parseEventLogs({ abi: v4Abi, logs: raw })) {
      if (e.eventName !== "Swap") continue;
      const p = byId.get(e.topics[1]!.toLowerCase());
      if (!p) continue;
      const age = e.blockNumber! - p.openBlock;
      if (age < 0n || age > MIN_FORWARD) continue; // outside this pool's hour
      const a = e.args as unknown as Record<string, bigint>;
      const mult = tokenPriceMultiple(p.openSqrt, Number(a.sqrtPriceX96));
      if (mult <= 0) continue;
      swapCount++;
      p.swaps++;
      if (mult > p.peak) { p.peak = mult; p.peakBlock = e.blockNumber!; }
      if (mult < p.trough) p.trough = mult;
      // A checkpoint holds the LAST price at or before it.
      for (let k = 0; k < cpBlocks.length; k++) if (age <= cpBlocks[k]) p.marks[k] = mult;
    }
    process.stdout.write(
      `\r  pass 2: ${Math.min(i + BATCH, pools.length)}/${pools.length} pools, ${(swapCount / 1000).toFixed(1)}k swaps  (${requests} requests)   `,
    );
  }
  console.log("\n");

  // ── results ───────────────────────────────────────────────────────────────
  const traded = pools.filter((p) => p.swaps >= 1);
  console.log(`${pools.length} native-ETH pools with a full 60 min of forward data`);
  console.log(`${traded.length} traded at all (${pools.length - traded.length} never got a single swap); ${swapCount} swaps\n`);
  if (!traded.length) return;

  const pct = (xs: number[], q: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(q * (s.length - 1))];
  };
  const fmt = (m: number) => ((m - 1) * 100).toFixed(1) + "%";

  console.log("PRICE vs the migration price, at each checkpoint");
  console.log("  when      n     p10     p25  median     p75     p90    mean    >0%");
  for (let i = 0; i < CHECKPOINTS.length; i++) {
    const xs = traded.map((p) => p.marks[i]);
    const up = xs.filter((v) => v > 1).length;
    const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
    console.log(
      `  ${(CHECKPOINTS[i] + "m").padEnd(6)}${String(xs.length).padStart(5)}` +
        `${fmt(pct(xs, 0.1)).padStart(8)}${fmt(pct(xs, 0.25)).padStart(8)}${fmt(pct(xs, 0.5)).padStart(8)}` +
        `${fmt(pct(xs, 0.75)).padStart(8)}${fmt(pct(xs, 0.9)).padStart(8)}${fmt(mean).padStart(8)}` +
        `${((up / xs.length) * 100).toFixed(0) + "%"}`.padStart(7),
    );
  }

  const peaks = traded.map((p) => p.peak);
  const troughs = traded.map((p) => p.trough);
  console.log(`\nBEST and WORST point in the first hour — the scalper's ceiling and floor`);
  console.log(`  peak   median ${fmt(pct(peaks, 0.5))}   p75 ${fmt(pct(peaks, 0.75))}   p90 ${fmt(pct(peaks, 0.9))}   p99 ${fmt(pct(peaks, 0.99))}`);
  console.log(`  trough median ${fmt(pct(troughs, 0.5))}   p25 ${fmt(pct(troughs, 0.25))}   p10 ${fmt(pct(troughs, 0.1))}`);
  const ttp = traded.map((p) => Number(p.peakBlock - p.openBlock) * blockSecs);
  console.log(`  time to peak: median ${pct(ttp, 0.5).toFixed(0)}s   p75 ${pct(ttp, 0.75).toFixed(0)}s   p90 ${pct(ttp, 0.9).toFixed(0)}s`);
  for (const thr of [1.1, 1.25, 1.5, 2.0]) {
    const n = peaks.filter((v) => v >= thr).length;
    console.log(`  ever reached +${((thr - 1) * 100).toFixed(0)}%: ${((n / peaks.length) * 100).toFixed(1)}%  (${n}/${peaks.length})`);
  }

  console.log(`\nHOLD THROUGH MIGRATION, scored honestly — sell at the checkpoint, not the peak`);
  for (let i = 0; i < CHECKPOINTS.length; i++) {
    const xs = traded.map((p) => p.marks[i]);
    const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, xs.length - 1));
    const se = sd / Math.sqrt(xs.length);
    const net = (mean - 1) * 100 - 1; // v4 pools charge their own fee on the way out
    console.log(
      `  sell ${(CHECKPOINTS[i] + "m").padEnd(4)}: mean ${fmt(mean).padStart(7)}` +
        `  net of 1% pool fee ${((net >= 0 ? "+" : "") + net.toFixed(1) + "%").padStart(7)}` +
        `  t=${((mean - 1) / se).toFixed(2)}`,
    );
  }
  console.log(`\n${requests} RPC requests total\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
