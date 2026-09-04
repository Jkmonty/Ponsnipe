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
 * Method: pons graduates into a v4 singleton PoolManager, which emits
 * Initialize (once per pool, carrying the token) and Swap (carrying
 * sqrtPriceX96). So one streamed pass over the PoolManager's logs gives an
 * exact price path per token with no reserve reconstruction at all.
 *
 * The migration is price-neutral by construction — the curve closes and the
 * pool opens at an identical 20.58 ETH per unit of supply — so anything this
 * finds is real post-migration demand, not a mechanical gap.
 *
 * Reads only. Nothing is signed.
 */
try {
  process.loadEnvFile?.(".env");
} catch {
  /* ignore */
}

import { createPublicClient, http, parseEventLogs, type Address } from "viem";

const RPC = process.env.BACKTEST_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address;
const LOG_CHUNK = 2000n;

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

const client = createPublicClient({ transport: http(RPC, { retryCount: 3, timeout: 30_000 }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MIN_INTERVAL = 1000 / Math.max(0.5, RPS);
let lastCall = 0;
async function rpc<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const wait = MIN_INTERVAL - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
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

interface Pool {
  token: string;
  openBlock: bigint;
  /** sqrtPriceX96 at pool open. Price ratios are taken against this. */
  openSqrt: number;
  swaps: number;
  /** Best and worst token price seen so far, as a multiple of the open. */
  peak: number;
  peakBlock: bigint;
  trough: number;
  /**
   * Token price at each checkpoint, as a multiple of the open. Seeded at 1 —
   * a pool with no swap yet is still sitting at exactly its opening price.
   */
  marks: number[];
  last: number;
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
  /** A pool needs this much forward data before its row means anything. */
  const MIN_FORWARD = cpBlocks[cpBlocks.length - 1];

  const spanBlocks = BigInt(Math.round((HOURS * 3600) / blockSecs));
  const start = head - spanBlocks;
  const totalChunks = Number(spanBlocks / LOG_CHUNK) + 1;

  console.log(`\npost-migration price action — last ${HOURS}h`);
  console.log(`v4 PoolManager ${POOL_MANAGER}`);
  console.log(`blocks ${start} → ${head} (block time ${blockSecs.toFixed(3)}s)`);
  console.log(`${totalChunks} chunks at ${RPS}/s → ~${((totalChunks / RPS) / 60).toFixed(0)} min`);
  console.log(`checkpoints at ${CHECKPOINTS.join("/")} min after the pool opens\n`);

  const pools = new Map<string, Pool>();
  const done: Pool[] = [];
  let swapCount = 0;
  const t0 = Date.now();
  let chunk = 0;

  for (let from = start; from <= head; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > head ? head : from + LOG_CHUNK - 1n;
    chunk++;

    const raw = (await rpc(() =>
      client.request({
        method: "eth_getLogs",
        params: [{ address: POOL_MANAGER, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }),
    )) as any[];
    const evs = parseEventLogs({ abi: v4Abi, logs: raw });

    for (const e of evs) {
      if (e.eventName === "Initialize") {
        const a = e.args as unknown as Record<string, string | bigint>;
        // Only native-ETH pools; a token quoted in USDG or a stock token is not
        // something we could have been holding through migration anyway.
        if ((a.currency0 as string).toLowerCase() !== "0x0000000000000000000000000000000000000000") continue;
        const sq = Number(a.sqrtPriceX96 as bigint);
        if (sq <= 0) continue;
        pools.set(e.topics[1]!.toLowerCase(), {
          token: (a.currency1 as string).toLowerCase(),
          openBlock: e.blockNumber!,
          openSqrt: sq,
          swaps: 0,
          peak: 1, peakBlock: e.blockNumber!, trough: 1,
          marks: CHECKPOINTS.map(() => 1),
          last: 1,
        });
      } else if (e.eventName === "Swap") {
        const p = pools.get(e.topics[1]!.toLowerCase());
        if (!p) continue; // pool opened before our window — not our sample
        swapCount++;
        const a = e.args as unknown as Record<string, bigint>;
        const mult = tokenPriceMultiple(p.openSqrt, Number(a.sqrtPriceX96));
        if (mult <= 0) continue;
        p.swaps++;
        p.last = mult;
        if (mult > p.peak) { p.peak = mult; p.peakBlock = e.blockNumber!; }
        if (mult < p.trough) p.trough = mult;
        // A checkpoint holds the LAST price at or before it, so keep updating
        // each one only while we are still inside its window. A checkpoint that
        // never sees a swap keeps its seeded 1.0 — the pool's opening price,
        // which is exactly where an untraded token still sits.
        const age = e.blockNumber! - p.openBlock;
        for (let i = 0; i < cpBlocks.length; i++) if (age <= cpBlocks[i]) p.marks[i] = mult;
      }
    }

    // Retire pools that have all the forward coverage they are going to get.
    for (const [k, p] of pools) {
      if (to - p.openBlock >= MIN_FORWARD) { done.push(p); pools.delete(k); }
    }

    if (chunk % 20 === 0 || chunk === totalChunks) {
      const pct = (chunk / totalChunks) * 100;
      const el = (Date.now() - t0) / 1000;
      process.stdout.write(
        `\r  ${pct.toFixed(1)}%  pools ${done.length + pools.size}  swaps ${(swapCount / 1000).toFixed(0)}k  ` +
          `eta ${((el / (pct / 100) - el) / 60).toFixed(0)}min    `,
      );
    }
  }

  const traded = done.filter((p) => p.swaps >= 1);
  console.log(`\n\n${done.length} native-ETH pools opened with a full ${CHECKPOINTS[CHECKPOINTS.length - 1]} min of forward data`);
  console.log(`${traded.length} traded at all (${done.length - traded.length} never got a single swap); ${swapCount} swaps seen\n`);
  if (!traded.length) return;

  const pct = (xs: number[], q: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(q * (s.length - 1))];
  };
  const fmt = (m: number) => ((m - 1) * 100).toFixed(1) + "%";

  console.log("PRICE vs the migration price, at each checkpoint (all figures are % moves)");
  console.log("  when      n     p10     p25  median     p75     p90    mean   >0%");
  for (let i = 0; i < CHECKPOINTS.length; i++) {
    const xs = traded.map((p) => p.marks[i]);
    if (!xs.length) continue;
    const up = xs.filter((v) => v > 1).length;
    const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
    console.log(
      `  ${(CHECKPOINTS[i] + "m").padEnd(6)}${String(xs.length).padStart(5)}` +
        `${fmt(pct(xs, 0.1)).padStart(8)}${fmt(pct(xs, 0.25)).padStart(8)}${fmt(pct(xs, 0.5)).padStart(8)}` +
        `${fmt(pct(xs, 0.75)).padStart(8)}${fmt(pct(xs, 0.9)).padStart(8)}${fmt(mean).padStart(8)}` +
        `${((up / xs.length) * 100).toFixed(0) + "%"}`.padStart(6),
    );
  }

  const peaks = traded.map((p) => p.peak);
  const troughs = traded.map((p) => p.trough);
  console.log(`\nBEST and WORST point reached in the first hour (the scalper's ceiling and floor)`);
  console.log(`  peak   median ${fmt(pct(peaks, 0.5))}   p75 ${fmt(pct(peaks, 0.75))}   p90 ${fmt(pct(peaks, 0.9))}   p99 ${fmt(pct(peaks, 0.99))}`);
  console.log(`  trough median ${fmt(pct(troughs, 0.5))}   p25 ${fmt(pct(troughs, 0.25))}   p10 ${fmt(pct(troughs, 0.1))}`);

  const timeToPeak = traded.map((p) => Number(p.peakBlock - p.openBlock) * blockSecs);
  console.log(`  time to that peak: median ${pct(timeToPeak, 0.5).toFixed(0)}s   p75 ${pct(timeToPeak, 0.75).toFixed(0)}s   p90 ${pct(timeToPeak, 0.9).toFixed(0)}s`);

  for (const thr of [1.1, 1.25, 1.5, 2.0]) {
    const n = peaks.filter((v) => v >= thr).length;
    console.log(`  reached +${((thr - 1) * 100).toFixed(0)}% at some point: ${((n / peaks.length) * 100).toFixed(1)}%  (${n}/${peaks.length})`);
  }

  console.log(`\nHOLD-THROUGH-MIGRATION, scored honestly (sell at the checkpoint, not the peak)`);
  for (let i = 0; i < CHECKPOINTS.length; i++) {
    const xs = traded.map((p) => p.marks[i]);
    if (!xs.length) continue;
    const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, xs.length - 1));
    const se = sd / Math.sqrt(xs.length);
    // v4 pools charge their own swap fee on the way out; 1% is the pons default.
    const net = (mean - 1) * 100 - 1;
    console.log(
      `  sell ${(CHECKPOINTS[i] + "m").padEnd(4)} after migration: mean ${fmt(mean).padStart(7)}` +
        `  net of 1% pool fee ${(net >= 0 ? "+" : "") + net.toFixed(1)}%` +
        `  t=${((mean - 1) / se).toFixed(2)}`,
    );
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
