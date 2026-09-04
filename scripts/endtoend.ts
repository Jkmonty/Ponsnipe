/**
 * The round trip: buy on the curve, hold THROUGH migration, sell in the pool.
 *
 *   npm run endtoend
 *   npm run endtoend -- --eth 0.01 --rps 2
 *
 * Every strategy tested so far sold back into the bonding curve before it
 * locked, and every one lost. Grad mode showed why: entering at 88-90% of the
 * threshold leaves almost no room before the 92% exit. But those same entries
 * graduate 57% of the time, and the post-migration measurement showed the pool
 * is where the move actually happens. Selling at 92% was quitting one block
 * early.
 *
 * WHY THIS SCRIPT EXISTS: the +50% "implied round-trip EV" was two separately
 * measured numbers multiplied together — a per-band graduation rate times an
 * average pool outcome. That silently assumes tokens graduating out of the
 * 88-90% band behave like the average graduate, which nothing established. This
 * tracks INDIVIDUAL tokens from curve entry through migration to a pool exit,
 * so the two halves are joined rather than multiplied.
 *
 * Two things the earlier pass got flattering:
 *   - it read sqrtPriceX96, the MARGINAL price, as though it were a fill. Here
 *     the exit is priced against the pool's actual liquidity, which matters
 *     most in exactly the thin pools that produce the big printed gains.
 *   - it leaned on a t-statistic over a wildly skewed distribution. Here the
 *     confidence interval is bootstrapped.
 *
 * Curve-side data is read from data/scan-grad.sqlite (no re-scan); only the
 * pool paths for tokens that actually graduated are fetched.
 *
 * Reads only. Nothing is signed.
 */
try {
  process.loadEnvFile?.(".env");
} catch {
  /* ignore */
}

import { DatabaseSync } from "node:sqlite";
import { createPublicClient, http, parseEventLogs, keccak256, toHex, type Address } from "viem";

const RPC = process.env.BACKTEST_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address;
const IN_DB = "./data/scan-grad.sqlite";

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1]);
    if (Number.isFinite(n)) return n;
  }
  return dflt;
}
const ETH_IN = arg("eth", 0.01);
const RPS = arg("rps", 2);

/**
 * The curve's price the instant it graduates, in ETH per whole token, and also
 * the price the v4 pool opens at — migration is price-neutral by construction.
 * quoteReserve 5.88 ETH over 2/7 of a 1e27 supply.
 */
const GRAD_PRICE = 5.88 / ((2 / 7) * 1e27 / 1e18);
/** v4 pools created by pons charge 1%, same as the curve. */
const POOL_FEE = 0.01;
const CHECKPOINTS = [1, 2, 3, 5];
const INIT_CHUNK = 20_000n;
const TOKENS_PER_QUERY = 1000;
const POOLS_PER_SWAP_QUERY = 40;
/** Max block span of one swap batch, so a query never covers much more than a single pool's hour. */
const SPAN_LIMIT = 2_000n;

const INIT_TOPIC = keccak256(toHex("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"));
const SWAP_TOPIC = keccak256(toHex("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
const Q96 = 2 ** 96;
/**
 * sqrtPrice a pons native pool must open at: it is seeded with 10/49 of a 1e27
 * supply against 4.2 ETH, and currency0 is ETH, so the encoded price is
 * token-wei per ETH-wei.
 */
const EXPECTED_OPEN_SQRT = Math.sqrt(((10 / 49) * 1e27) / 4.2e18);

const v4Abi = [
  {
    type: "event",
    name: "Initialize",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "currency0", type: "address", indexed: true },
      { name: "currency1", type: "address", indexed: true },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
    ],
  },
  {
    type: "event",
    name: "Swap",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "amount0", type: "int128" },
      { name: "amount1", type: "int128" },
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "liquidity", type: "uint128" },
      { name: "tick", type: "int24" },
      { name: "fee", type: "uint24" },
    ],
  },
] as const;

const client = createPublicClient({ transport: http(RPC, { retryCount: 1, timeout: 20_000 }) });
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

type Hex = `0x${string}`;
async function fetchLogs(from: bigint, to: bigint, topics: (Hex | Hex[] | null)[]): Promise<unknown[]> {
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
    const tooBig = /exceeds limit|more than|too many logs|exceeded the size limit|body exceeded|timed out|timeout/i;
    if (to <= from || !tooBig.test(String(e))) throw e;
    const mid = from + (to - from) / 2n;
    const left = await fetchLogs(from, mid, topics);
    const right = await fetchLogs(mid + 1n, to, topics);
    return left.concat(right);
  }
}

/** One observation of a pool: where the price is and how deep the book is. */
interface Mark {
  sqrt: number; // sqrtPriceX96 / 2^96
  liq: number; // active liquidity L
}
interface Pool {
  id: string;
  token: string;
  openBlock: bigint;
  open: Mark;
  swaps: number;
  marks: Mark[]; // one per checkpoint, last at or before it
}

/**
 * What selling `tokensWei` into this pool actually realises, in ETH.
 *
 * currency0 is native ETH and currency1 the token, so selling raises sqrtPrice:
 *   amount1 = L * (s' - s)      =>  s' = s + amount1 / L
 *   amount0 = L * (1/s' - 1/s)  =>  ETH out = L * (1/s - 1/s')
 * This is the single-tick-range form. Crossing ticks can only make the fill
 * worse, so treat the result as an upper bound — still far closer than reading
 * the marginal price and calling it a fill.
 */
function ethOutForSale(m: Mark, tokensWei: number): number {
  if (m.liq <= 0 || m.sqrt <= 0) return 0;
  const sNew = m.sqrt + tokensWei / m.liq;
  const out = m.liq * (1 / m.sqrt - 1 / sNew);
  return out > 0 ? out : 0;
}

/** Percentile of an unsorted array. */
function pct(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.floor(q * (s.length - 1))))];
}

/**
 * Bootstrap CI for the mean. The distribution here is dominated by a thin right
 * tail, which is exactly the case where a t-statistic overstates confidence.
 */
function bootstrapMeanCI(xs: number[], iters = 2000): [number, number] {
  if (xs.length < 2) return [NaN, NaN];
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let k = 0; k < xs.length; k++) s += xs[(Math.random() * xs.length) | 0];
    means.push(s / xs.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * iters)], means[Math.floor(0.975 * iters)]];
}

async function main() {
  const db = new DatabaseSync(IN_DB);

  // ── curve side: what each band bought, and what became of it ──────────────
  const bands = (
    db.prepare("SELECT DISTINCT preset FROM sims").all() as unknown as { preset: string }[]
  )
    .map((r) => r.preset)
    .filter((p) => p.endsWith("/safe")) // one exit rule; the stop-loss is kept, only the 92% sale changes
    .sort();

  interface Entry {
    token: string;
    entryPrice: number;
    reason: string;
    curvePnl: number;
  }
  const byBand = new Map<string, Entry[]>();
  const gradTokens = new Set<string>();
  for (const b of bands) {
    const rows = db
      .prepare("SELECT token, entry_price, reason, pnl_pct FROM sims WHERE preset = ?")
      .all(b) as unknown as { token: string; entry_price: number; reason: string; pnl_pct: number }[];
    const es = rows.map((r) => ({
      token: r.token,
      entryPrice: r.entry_price,
      reason: r.reason,
      curvePnl: r.pnl_pct,
    }));
    byBand.set(b, es);
    for (const e of es) if (e.reason === "graduation_exit") gradTokens.add(e.token);
  }

  const range = db.prepare("SELECT MIN(launch_block) a, MAX(launch_block) b FROM launches").get() as unknown as {
    a: number;
    b: number;
  };
  console.log(`\nend-to-end round trip — curve entry → migration → pool exit`);
  console.log(`curve data: ${IN_DB}, blocks ${range.a} → ${range.b}`);
  console.log(`${bands.length} bands, ${gradTokens.size} distinct tokens reached graduation`);
  console.log(`position ${ETH_IN} ETH, pool fee ${(POOL_FEE * 100).toFixed(0)}%, exits at ${CHECKPOINTS.join("/")} min\n`);

  const head = await rpc(() => client.getBlockNumber());
  const hb = await rpc(() => client.getBlock({ blockNumber: head }));
  const pb = await rpc(() => client.getBlock({ blockNumber: head - 50_000n }));
  const blockSecs = Number(hb.timestamp - pb.timestamp) / 50_000;
  const cpBlocks = CHECKPOINTS.map((m) => BigInt(Math.round((m * 60) / blockSecs)));
  const MIN_FORWARD = cpBlocks[cpBlocks.length - 1];

  // ── pass 1: find the pool for each graduated token ────────────────────────
  // currency1 is indexed, so the tokens can be pushed into the filter directly.
  const tokens = [...gradTokens];
  const pools = new Map<string, Pool>(); // token -> pool
  let oddOpen = 0;
  const from0 = BigInt(range.a);
  const to0 = BigInt(range.b) + MIN_FORWARD + 10_000n;

  for (let i = 0; i < tokens.length; i += TOKENS_PER_QUERY) {
    const slice = tokens.slice(i, i + TOKENS_PER_QUERY);
    const padded = slice.map((t) => ("0x" + t.slice(2).padStart(64, "0")) as Hex);
    for (let f = from0; f <= to0; f += INIT_CHUNK) {
      const t = f + INIT_CHUNK - 1n > to0 ? to0 : f + INIT_CHUNK - 1n;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = (await fetchLogs(f, t, [INIT_TOPIC, null, null, padded])) as any[];
      for (const e of parseEventLogs({ abi: v4Abi, logs: raw })) {
        if (e.eventName !== "Initialize") continue;
        const a = e.args as unknown as Record<string, string | bigint>;
        const token = (a.currency1 as string).toLowerCase();
        if (pools.has(token)) continue;
        // MUST be the native-ETH pool. A token can be currency1 of several
        // pools; matching one quoted in something else puts the price on a
        // completely different scale and poisons every statistic downstream.
        if ((a.currency0 as string).toLowerCase() !== "0x0000000000000000000000000000000000000000") continue;
        const sq = Number(a.sqrtPriceX96 as bigint) / Q96;
        if (sq <= 0) continue;
        // Every pons native graduation opens at the same price by construction.
        // Anything else is not the pool we think it is — refuse it loudly rather
        // than letting one bad scale run away with the mean.
        if (Math.abs(sq / EXPECTED_OPEN_SQRT - 1) > 0.05) {
          oddOpen++;
          continue;
        }
        pools.set(token, {
          id: e.topics[1]!.toLowerCase(),
          token,
          openBlock: e.blockNumber!,
          open: { sqrt: sq, liq: 0 },
          swaps: 0,
          marks: CHECKPOINTS.map(() => ({ sqrt: sq, liq: 0 })),
        });
      }
    }
    process.stdout.write(`\r  pass 1: ${pools.size} pools found for ${Math.min(i + TOKENS_PER_QUERY, tokens.length)}/${tokens.length} tokens  (${requests} req)   `);
  }
  console.log("");
  if (oddOpen) console.log(`  (${oddOpen} pools rejected: opening price not a pons graduation)`);

  // ── pass 2: their swaps ───────────────────────────────────────────────────
  const list = [...pools.values()].sort((a, b) => (a.openBlock < b.openBlock ? -1 : 1));
  const byId = new Map(list.map((p) => [p.id, p]));
  let swaps = 0;

  // Batch by block PROXIMITY, not by pool count. These pools are spread across
  // five days, so taking 40 of them in a row spans ~272k blocks and every query
  // drags in a range far wider than any single pool needs — which is what hung
  // the first attempt. Each pool only cares about its own hour, so group pools
  // that open close together and the range stays near MIN_FORWARD.
  const batches: Pool[][] = [];
  for (let i = 0; i < list.length; ) {
    const batch: Pool[] = [list[i++]];
    while (
      i < list.length &&
      batch.length < POOLS_PER_SWAP_QUERY &&
      list[i].openBlock - batch[0].openBlock < SPAN_LIMIT
    ) {
      batch.push(list[i++]);
    }
    batches.push(batch);
  }

  let doneP = 0;
  for (const batch of batches) {
    const f = batch[0].openBlock;
    const t = batch[batch.length - 1].openBlock + MIN_FORWARD;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (await fetchLogs(f, t, [SWAP_TOPIC, batch.map((p) => p.id as Hex)])) as any[];
    for (const e of parseEventLogs({ abi: v4Abi, logs: raw })) {
      if (e.eventName !== "Swap") continue;
      const p = byId.get(e.topics[1]!.toLowerCase());
      if (!p) continue;
      const age = e.blockNumber! - p.openBlock;
      if (age < 0n || age > MIN_FORWARD) continue;
      const a = e.args as unknown as Record<string, bigint>;
      const sq = Number(a.sqrtPriceX96) / Q96;
      const liq = Number(a.liquidity);
      if (sq <= 0) continue;
      swaps++;
      p.swaps++;
      for (let k = 0; k < cpBlocks.length; k++) if (age <= cpBlocks[k]) p.marks[k] = { sqrt: sq, liq };
    }
    doneP += batch.length;
    process.stdout.write(`\r  pass 2: ${doneP}/${list.length} pools in ${batches.length} batches, ${(swaps / 1000).toFixed(1)}k swaps  (${requests} req)   `);
  }
  console.log("\n");

  const noPool = tokens.filter((t) => !pools.has(t)).length;
  const untraded = list.filter((p) => p.swaps === 0).length;
  console.log(`${pools.size} pools located (${noPool} tokens had no pool in range)`);
  console.log(`${untraded} of those pools never traded — those positions cannot be exited at all\n`);

  // ── the round trip, per band, per exit time ───────────────────────────────
  console.log("ROUND TRIP: buy in band, keep the stop-loss, hold through migration, sell in the pool");
  console.log("A position in a pool that never traded is scored as a TOTAL LOSS — there is no bid.\n");
  console.log("  band      exit      n    win     mean  trim5%   median      p90   95% CI (bootstrap)");

  for (const band of bands) {
    const entries = byBand.get(band)!;
    if (!entries.length) continue;
    for (let k = 0; k < CHECKPOINTS.length; k++) {
      const pnls: number[] = [];
      for (const e of entries) {
        if (e.reason !== "graduation_exit") {
          // Never graduated: the curve sim already scored it (stop-loss etc.).
          pnls.push(e.curvePnl);
          continue;
        }
        const p = pools.get(e.token);
        if (!p) continue; // graduated outside the pool window — unmeasurable, drop
        if (p.swaps === 0) {
          pnls.push(-100); // no bid ever appeared; the position is dead
          continue;
        }
        const tokensHeld = ETH_IN / e.entryPrice; // whole tokens
        const out = ethOutForSale(p.marks[k], tokensHeld * 1e18) / 1e18;
        pnls.push(((out * (1 - POOL_FEE) - ETH_IN) / ETH_IN) * 100);
      }
      if (pnls.length < 20) continue;
      const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
      // A 5% trim on each side: if one token can move the headline, the
      // headline is not describing the strategy.
      const sorted = [...pnls].sort((a, b) => a - b);
      const cut = Math.floor(sorted.length * 0.05);
      const trimmed = sorted.slice(cut, sorted.length - cut);
      const tmean = trimmed.reduce((s, v) => s + v, 0) / Math.max(1, trimmed.length);
      const [lo, hi] = bootstrapMeanCI(pnls);
      const win = (pnls.filter((v) => v > 0).length / pnls.length) * 100;
      console.log(
        `  ${band.replace("/safe", "").padEnd(9)}${(CHECKPOINTS[k] + "m").padEnd(6)}` +
          `${String(pnls.length).padStart(6)}${(win.toFixed(0) + "%").padStart(7)}` +
          `${(mean.toFixed(1) + "%").padStart(9)}${(tmean.toFixed(1) + "%").padStart(8)}${(pct(pnls, 0.5).toFixed(1) + "%").padStart(9)}` +
          `${(pct(pnls, 0.9).toFixed(1) + "%").padStart(9)}` +
          `   [${lo.toFixed(1)}%, ${hi.toFixed(1)}%]`,
      );
    }
    console.log("");
  }

  // ── how much of this is the fill model? ───────────────────────────────────
  console.log("SPOT vs REALISED — what pricing the exit against real liquidity costs");
  const band = bands.find((b) => b.startsWith("g88_90")) ?? bands[bands.length - 1];
  const es = byBand.get(band)!.filter((e) => e.reason === "graduation_exit");
  for (let k = 0; k < CHECKPOINTS.length; k++) {
    let spotSum = 0, realSum = 0, n = 0;
    for (const e of es) {
      const p = pools.get(e.token);
      if (!p || p.swaps === 0) continue;
      const tokensHeld = ETH_IN / e.entryPrice;
      const mult = (p.open.sqrt / p.marks[k].sqrt) ** 2;
      const spot = tokensHeld * GRAD_PRICE * mult;
      const real = ethOutForSale(p.marks[k], tokensHeld * 1e18) / 1e18;
      spotSum += ((spot * (1 - POOL_FEE) - ETH_IN) / ETH_IN) * 100;
      realSum += ((real * (1 - POOL_FEE) - ETH_IN) / ETH_IN) * 100;
      n++;
    }
    if (!n) continue;
    console.log(
      `  ${band.replace("/safe", "")} @ ${(CHECKPOINTS[k] + "m").padEnd(4)} spot ${(spotSum / n).toFixed(1).padStart(8)}%   realised ${(realSum / n).toFixed(1).padStart(8)}%   (n=${n})`,
    );
  }
  console.log(`\n${requests} RPC requests\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
