/**
 * Backtest the sniper filters + exit rules against real pons launch history.
 *
 *   npm run backtest                          # 12 windows across the last 5 days
 *   npm run backtest -- --days 5 --windows 12 --eth 0.01 --delay 20
 *   npm run backtest -- --days 1 --windows 6  # tighter, faster
 *
 * Sampling: a contiguous 5-day scrape is ~4.2M blocks and ~10M trade events —
 * hours of RPC time and gigabytes of memory. What actually matters is temporal
 * SPREAD (different times of day, different market moods), so we sample evenly
 * spaced windows across the range instead. Coverage spans the full period.
 *
 * Method: replay every CurveBuy/CurveSell on every launched curve in each
 * window, reconstruct the exact reserve/price series from the event fields (the
 * same delta maths the live monitor uses), then run the REAL filter and
 * exit-rule code over it — validating production logic, not a copy of it.
 *
 * Reads only. Nothing is signed or sent.
 */
try {
  process.loadEnvFile?.(".env");
} catch {
  /* ignore */
}

import {
  createPublicClient,
  http,
  parseAbiItem,
  parseEventLogs,
  keccak256,
  toHex,
  parseEther,
  getAddress,
  type Address,
} from "viem";
import { robinhoodChain } from "../src/lib/chain";
import { bondingCurveAbi, erc20Abi } from "../src/lib/pons/abis";
import { quoteBuy, quoteSell, priceFromReserves, type CurveReserves } from "../src/lib/pons/pricing";
import { evaluateExit, graduationProgressPct } from "../src/lib/engine/rules";
import { evaluateLaunch } from "../src/lib/sniper/filters";
import { DEFAULT_CONFIG, type SniperConfig } from "../src/lib/sniper/config";
import type { PositionRow } from "../src/lib/db/positions";
import type { TokenSnapshot } from "../src/lib/pons/tokens";

/**
 * The backtest deliberately does NOT default to RPC_URL.
 *
 * Bulk history needs wide eth_getLogs ranges, and provider free tiers cap them
 * hard (Alchemy free = 10 blocks, which would turn a 5-day scan into ~424k
 * requests). The public Robinhood endpoint allows 2000-block ranges — slower
 * per request but vastly fewer of them. Keep RPC_URL pointed at your fast
 * provider for the live app; override here only if you have a paid plan.
 */
const RPC =
  process.env.BACKTEST_RPC_URL ||
  (process.argv.includes("--use-main-rpc") ? process.env.RPC_URL : "") ||
  "https://rpc.mainnet.chain.robinhood.com";
const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as Address;
const NATIVE = "0x0000000000000000000000000000000000000000";
const LOG_CHUNK = 2000n;
const MULTICALL_BATCH = 150;

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1]);
    if (Number.isFinite(n)) return n;
  }
  return dflt;
}

const DAYS = arg("days", 5);
const WINDOWS = arg("windows", 12);
/** Blocks per sampled window. Half is used for entries, half as forward data. */
const WINDOW_BLOCKS = BigInt(arg("windowblocks", 30000));
const ETH_PER_TRADE = String(arg("eth", 0.01));
const DELAY_SECONDS = arg("delay", 20);

/** Exit strategies to compare. `grad` = bail out at % toward graduation. */
const PRESETS: Record<string, { tp: number | null; sl: number | null; trail: number | null; grad: number | null }> = {
  "Safe +25/-15": { tp: 25, sl: 15, trail: null, grad: 92 },
  "Balanced +50/-25": { tp: 50, sl: 25, trail: null, grad: 92 },
  "Moonshot +150/-50": { tp: 150, sl: 50, trail: null, grad: 92 },
  "Wide +300/-80": { tp: 300, sl: 80, trail: null, grad: 92 },
  "TP only +50": { tp: 50, sl: null, trail: null, grad: 92 },
  "TP only +100": { tp: 100, sl: null, trail: null, grad: 92 },
  "Trail 25%": { tp: null, sl: null, trail: 25, grad: 92 },
  "Trail 40%": { tp: null, sl: null, trail: 40, grad: 92 },
  "No stop, ride to grad": { tp: null, sl: null, trail: null, grad: 92 },
  /** No exits at all — used to measure how many launches reach graduation. */
  "Hold, no exits": { tp: null, sl: null, trail: null, grad: null },
};

/** Filter dimensions to sweep. */
const SWEEP = {
  minOtherBuys: [0, 3, 5, 10, 20],
  minLiquidityEth: [0, 0.05, 0.2, 0.5],
  minBuyVelocity: [null, 0.2, 0.5, 1] as (number | null)[],
};

const client = createPublicClient({
  chain: robinhoodChain,
  // No transport-level JSON-RPC batching: the public endpoint mishandles
  // batched arrays, which breaks the raw eth_getLogs path. Client-level
  // multicall batching is separate (it aggregates eth_call via multicall3).
  transport: http(RPC, { retryCount: 3, timeout: 30_000 }),
  batch: { multicall: { wait: 16 } },
});

const launchEvent = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
);
const T0_BUY = keccak256(toHex("CurveBuy(address,address,uint256,uint256,uint256,uint256)"));
const T0_SELL = keccak256(toHex("CurveSell(address,address,uint256,uint256,uint256,uint256)"));

interface Launch {
  token: Address;
  curve: Address;
  deployer: Address;
  pairToken: string;
  threshold: bigint;
  block: bigint;
  window: number;
}
interface Trade {
  block: bigint;
  index: number;
  kind: "CurveBuy" | "CurveSell";
  actor: string;
  quote: bigint;
  tokens: bigint;
  fee: bigint;
  tax: bigint;
}
interface CurveMeta {
  phantom: bigint;
  feeBps: number;
  creatorTaxBps: number;
  supply: bigint;
  symbol: string;
  decimals: number;
}

const log = (m: string) => process.stdout.write(`${m}\n`);
const prog = (m: string) => process.stdout.write(`\r${m}   `);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The public Robinhood Chain RPC returns 429 under sustained load, so every
 * call goes through a single-file throttle with exponential backoff. A private
 * RPC can run far higher — raise --rps to match it.
 */
const MIN_INTERVAL_MS = 1000 / Math.max(0.5, arg("rps", 4));
let lastCall = 0;
let queue: Promise<unknown> = Promise.resolve();
let throttleWaits = 0;

function is429(e: unknown): boolean {
  const s = JSON.stringify((e as { code?: number; details?: string })?.code ?? "") + String(e);
  return s.includes("429") || /too many requests/i.test(String(e));
}

/** Serialise + pace all RPC traffic; retry 429s with backoff. */
function rpc<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const wait = MIN_INTERVAL_MS - (Date.now() - lastCall);
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      try {
        return await fn();
      } catch (e) {
        if (!is429(e) || attempt >= 6) throw e;
        const backoff = Math.min(30_000, 1000 * 2 ** attempt);
        throttleWaits++;
        await sleep(backoff);
      }
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

function applyTrade(r: CurveReserves, t: Trade): CurveReserves {
  if (t.kind === "CurveSell") {
    const gross = t.quote + t.fee + t.tax;
    return {
      quoteReserve: r.quoteReserve > gross ? r.quoteReserve - gross : 0n,
      tokenReserve: r.tokenReserve + t.tokens,
    };
  }
  const net = t.quote - t.fee - t.tax;
  return {
    quoteReserve: r.quoteReserve + (net > 0n ? net : 0n),
    tokenReserve: r.tokenReserve > t.tokens ? r.tokenReserve - t.tokens : 0n,
  };
}

async function getLogsChunked<T>(
  fromBlock: bigint,
  toBlock: bigint,
  fetch: (from: bigint, to: bigint) => Promise<T[]>,
  onProgress?: (done: bigint, total: bigint) => void,
): Promise<T[]> {
  const out: T[] = [];
  const total = toBlock - fromBlock + 1n;
  for (let from = fromBlock; from <= toBlock; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > toBlock ? toBlock : from + LOG_CHUNK - 1n;
    out.push(...(await rpc(() => fetch(from, to))));
    onProgress?.(to - fromBlock + 1n, total);
  }
  return out;
}

async function fetchMeta(launches: Launch[]): Promise<Map<string, CurveMeta>> {
  const out = new Map<string, CurveMeta>();
  for (let i = 0; i < launches.length; i += MULTICALL_BATCH) {
    const slice = launches.slice(i, i + MULTICALL_BATCH);
    const contracts = slice.flatMap((l) => [
      { address: l.curve, abi: bondingCurveAbi, functionName: "getReserves" as const },
      { address: l.curve, abi: bondingCurveAbi, functionName: "realQuoteReserve" as const },
      { address: l.curve, abi: bondingCurveAbi, functionName: "feeBps" as const },
      { address: l.curve, abi: bondingCurveAbi, functionName: "creatorTaxBps" as const },
      { address: l.token, abi: erc20Abi, functionName: "totalSupply" as const },
      { address: l.token, abi: erc20Abi, functionName: "symbol" as const },
      { address: l.token, abi: erc20Abi, functionName: "decimals" as const },
    ]);
    const res = await rpc(() => client.multicall({ contracts, allowFailure: true }));
    const N = 7;
    for (let j = 0; j < slice.length; j++) {
      const b = j * N;
      if (res[b].status !== "success" || res[b + 1].status !== "success") continue;
      const [qRes] = res[b].result as readonly [bigint, bigint];
      out.set(slice[j].curve.toLowerCase(), {
        phantom: qRes - (res[b + 1].result as bigint),
        feeBps: res[b + 2].status === "success" ? Number(res[b + 2].result) : 100,
        creatorTaxBps: res[b + 3].status === "success" ? Number(res[b + 3].result) : 0,
        supply: res[b + 4].status === "success" ? (res[b + 4].result as bigint) : 10n ** 27n,
        symbol: res[b + 5].status === "success" ? String(res[b + 5].result) : "???",
        decimals: res[b + 6].status === "success" ? Number(res[b + 6].result) : 18,
      });
    }
    prog(`  metadata ${Math.min(i + MULTICALL_BATCH, launches.length)}/${launches.length}`);
  }
  log("");
  return out;
}

/** State at the moment we would enter, computed once per launch. */
interface Entry {
  launch: Launch;
  meta: CurveMeta;
  reserves: CurveReserves; // AFTER our own buy
  held: bigint;
  entryPrice: number;
  liquidityEth: number;
  otherBuys: number;
  buyVelocity: number;
  restIndex: number; // index into trades to continue from
  snapshot: TokenSnapshot;
}

function fakeRow(
  e: Entry,
  preset: { tp: number | null; sl: number | null; trail: number | null; grad: number | null },
  ethIn: bigint,
): PositionRow {
  return {
    id: "bt", status: "open", token_address: "0x", token_symbol: e.meta.symbol,
    token_decimals: e.meta.decimals, curve_address: "0x", pair_token: NATIVE,
    quote_symbol: "ETH", quote_decimals: 18, fee_bps: e.meta.feeBps,
    creator_tax_bps: e.meta.creatorTaxBps, quote_in_wei: ethIn.toString(),
    tokens_held_wei: e.held.toString(), entry_price: e.entryPrice, buy_tx: null,
    source: "sniper", take_profit_pct: preset.tp, stop_loss_pct: preset.sl,
    trailing_stop_pct: preset.trail, graduation_exit_pct: preset.grad,
    graduation_threshold_wei: e.launch.threshold.toString(), slippage_bps: 800,
    peak_price: e.entryPrice, last_price: e.entryPrice, last_checked_at: null,
    sell_attempts: 0, last_dry_run_at: null, exit_price: null, quote_out_wei: null,
    realised_pnl_pct: null, sell_tx: null, close_reason: null, error: null,
    created_at: "", updated_at: "",
  };
}

/** Compute the entry state for a launch, or null if it can't be entered. */
function buildEntry(
  launch: Launch,
  meta: CurveMeta,
  trades: Trade[],
  entryBlockDelay: bigint,
  blockSecs: number,
  ethIn: bigint,
): Entry | null {
  let reserves: CurveReserves = { quoteReserve: meta.phantom, tokenReserve: meta.supply };
  const entryBlock = launch.block + entryBlockDelay;
  const dep = launch.deployer.toLowerCase();
  const buyers = new Set<string>();
  let buyCount = 0;
  let i = 0;
  for (; i < trades.length && trades[i].block < entryBlock; i++) {
    const t = trades[i];
    if (t.kind === "CurveBuy" && t.actor !== dep) {
      buyers.add(t.actor);
      buyCount++;
    }
    reserves = applyTrade(reserves, t);
  }
  if (reserves.tokenReserve <= 0n || reserves.quoteReserve <= 0n) return null;

  const realQuote = reserves.quoteReserve > meta.phantom ? reserves.quoteReserve - meta.phantom : 0n;
  const windowSecs = Number(entryBlockDelay) * blockSecs;
  const q = quoteBuy(ethIn, reserves, BigInt(meta.feeBps), BigInt(meta.creatorTaxBps));
  if (q.tokensOut <= 0n) return null;

  const priceAtEntry = priceFromReserves(reserves, meta.decimals, 18);
  const snapshot = {
    symbol: meta.symbol, name: meta.symbol, decimals: meta.decimals, venue: "curve",
    tradeable: true, quoteIsNative: true, quoteSymbol: "ETH",
    creatorTaxBps: meta.creatorTaxBps, feeBps: meta.feeBps, reserves, price: priceAtEntry,
    graduation: {
      graduated: false, readyToGraduate: false,
      currentQuote: Number(realQuote) / 1e18,
      thresholdQuote: Number(launch.threshold) / 1e18,
      thresholdWei: launch.threshold,
      progressPct: graduationProgressPct(realQuote, launch.threshold.toString()) ?? 0,
    },
  } as unknown as TokenSnapshot;

  const after = applyTrade(reserves, {
    block: entryBlock, index: 0, kind: "CurveBuy", actor: "self",
    quote: ethIn, tokens: q.tokensOut, fee: q.fee, tax: q.tax,
  });

  return {
    launch, meta, reserves: after, held: q.tokensOut,
    entryPrice: Number(ethIn) / 1e18 / (Number(q.tokensOut) / 10 ** meta.decimals),
    liquidityEth: Number(realQuote) / 1e18,
    otherBuys: buyers.size,
    buyVelocity: windowSecs > 0 ? buyCount / windowSecs : 0,
    restIndex: i,
    snapshot,
  };
}

type Result =
  | { kind: "closed"; reason: string; pnlPct: number; ethOut: number }
  | { kind: "stranded"; pnlPct: number }
  | { kind: "open"; pnlPct: number };

/** Walk forward from entry applying the real exit rules. */
function runPreset(
  e: Entry,
  trades: Trade[],
  preset: { tp: number | null; sl: number | null; trail: number | null; grad: number | null },
  ethIn: bigint,
): Result {
  let reserves = e.reserves;
  const row = fakeRow(e, preset, ethIn);
  const inEth = Number(ethIn) / 1e18;
  const { meta, launch } = e;
  const fee = BigInt(meta.feeBps);
  const tax = BigInt(meta.creatorTaxBps);

  for (let i = e.restIndex; i < trades.length; i++) {
    reserves = applyTrade(reserves, trades[i]);
    if (reserves.tokenReserve <= 0n || reserves.quoteReserve <= 0n) break;

    const price = priceFromReserves(reserves, meta.decimals, 18).priceQuote;
    const rq = reserves.quoteReserve > meta.phantom ? reserves.quoteReserve - meta.phantom : 0n;
    const gradPct = graduationProgressPct(rq, launch.threshold.toString());

    const d = evaluateExit(row, { price, graduationPct: gradPct });
    row.peak_price = d.peakPrice;
    row.last_price = price;

    if (d.shouldExit && d.reason) {
      const s = quoteSell(e.held, reserves, fee, tax);
      const ethOut = Number(s.quoteOut) / 1e18;
      return { kind: "closed", reason: d.reason, pnlPct: ((ethOut - inEth) / inEth) * 100, ethOut };
    }
    if (rq >= launch.threshold) {
      const s = quoteSell(e.held, reserves, fee, tax);
      return { kind: "stranded", pnlPct: ((Number(s.quoteOut) / 1e18 - inEth) / inEth) * 100 };
    }
  }
  const s = quoteSell(e.held, reserves, fee, tax);
  return { kind: "open", pnlPct: ((Number(s.quoteOut) / 1e18 - inEth) / inEth) * 100 };
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function main() {
  log(`\npons backtest — ${WINDOWS} windows across the last ${DAYS} days`);
  log(`${ETH_PER_TRADE} ETH/trade, ${DELAY_SECONDS}s entry delay`);
  log(`RPC ${RPC.replace(/\/v2\/.*$/, "/v2/***")}\n`);

  const head = await rpc(() => client.getBlockNumber());
  const hb = await rpc(() => client.getBlock({ blockNumber: head }));
  const pb = await rpc(() => client.getBlock({ blockNumber: head - 50_000n }));
  const blockSecs = Number(hb.timestamp - pb.timestamp) / 50_000;
  const entryBlockDelay = BigInt(Math.max(1, Math.round(DELAY_SECONDS / blockSecs)));
  const daySpan = BigInt(Math.round(86400 / blockSecs));
  const totalSpan = daySpan * BigInt(DAYS);
  const step = totalSpan / BigInt(WINDOWS);

  log(`block time ${blockSecs.toFixed(3)}s · entry delay ≈ ${entryBlockDelay} blocks`);
  log(`sampling ${WINDOWS} × ${WINDOW_BLOCKS} blocks (~${((Number(WINDOW_BLOCKS) * blockSecs) / 60).toFixed(0)}min each) evenly across ${DAYS} days\n`);

  const allLaunches: Launch[] = [];
  const tradesByCurve = new Map<string, Trade[]>();
  const windowInfo: { idx: number; hoursAgo: number; launches: number }[] = [];

  for (let w = 0; w < WINDOWS; w++) {
    const wEnd = head - step * BigInt(w);
    const wStart = wEnd - WINDOW_BLOCKS + 1n;
    if (wStart <= 0n) break;
    const hoursAgo = (Number(head - wEnd) * blockSecs) / 3600;

    const lg = await getLogsChunked(wStart, wEnd, (f, t) =>
      client.getLogs({ address: FACTORY, event: launchEvent, fromBlock: f, toBlock: t }),
    );
    // Only launches in the FIRST half of the window: the second half is their
    // forward data. Otherwise a launch could hit a stop but never a target.
    const entryCutoff = wStart + WINDOW_BLOCKS / 2n;
    let n = 0;
    for (const l of lg) {
      if (l.blockNumber! > entryCutoff) continue;
      allLaunches.push({
        token: getAddress(l.args.token as string),
        curve: getAddress(l.args.curve as string),
        deployer: getAddress(l.args.deployer as string),
        pairToken: (l.args.pairToken as string).toLowerCase(),
        threshold: l.args.graduationThreshold as bigint,
        block: l.blockNumber!,
        window: w,
      });
      n++;
    }
    windowInfo.push({ idx: w, hoursAgo, launches: n });

    const raw = await getLogsChunked(wStart, wEnd, async (f, t) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (await client.request({
        method: "eth_getLogs",
        params: [{ fromBlock: `0x${f.toString(16)}`, toBlock: `0x${t.toString(16)}`, topics: [[T0_BUY, T0_SELL]] }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as any[];
    });
    const parsed = parseEventLogs({ abi: bondingCurveAbi, logs: raw });
    for (const ev of parsed) {
      if (ev.eventName !== "CurveBuy" && ev.eventName !== "CurveSell") continue;
      const a = ev.args as unknown as Record<string, bigint | string>;
      const t: Trade = {
        block: ev.blockNumber!, index: ev.logIndex!, kind: ev.eventName,
        actor: String(ev.eventName === "CurveBuy" ? a.buyer : a.seller).toLowerCase(),
        quote: (ev.eventName === "CurveBuy" ? a.quoteIn : a.quoteOut) as bigint,
        tokens: (ev.eventName === "CurveBuy" ? a.tokensOut : a.tokensIn) as bigint,
        fee: a.fee as bigint, tax: a.tax as bigint,
      };
      const key = ev.address.toLowerCase();
      const arr = tradesByCurve.get(key);
      if (arr) arr.push(t);
      else tradesByCurve.set(key, [t]);
    }
    prog(`  window ${w + 1}/${WINDOWS} (${hoursAgo.toFixed(0)}h ago) — ${allLaunches.length} launches, ${tradesByCurve.size} curves`);
  }
  log("\n");
  for (const arr of tradesByCurve.values()) {
    arr.sort((x, y) => (x.block === y.block ? x.index - y.index : Number(x.block - y.block)));
  }

  const native = allLaunches.filter((l) => l.pairToken === NATIVE);
  log(
    `${allLaunches.length} launches sampled across ${DAYS} days · ` +
      `${native.length} native-ETH (${((native.length / allLaunches.length) * 100).toFixed(0)}%)`,
  );
  const meta = await fetchMeta(native);

  // Build entry state once per launch, then run each preset forward once.
  const ethIn = parseEther(ETH_PER_TRADE);
  const entries: Entry[] = [];
  for (const l of native) {
    const m = meta.get(l.curve.toLowerCase());
    if (!m) continue;
    const t = tradesByCurve.get(l.curve.toLowerCase()) ?? [];
    const e = buildEntry(l, m, t, entryBlockDelay, blockSecs, ethIn);
    if (e) entries.push(e);
  }
  log(`${entries.length} enterable\n`);

  const outcomes = new Map<string, Result[]>();
  for (const [name, preset] of Object.entries(PRESETS)) {
    const rs: Result[] = [];
    for (const e of entries) {
      rs.push(runPreset(e, tradesByCurve.get(e.launch.curve.toLowerCase()) ?? [], preset, ethIn));
    }
    outcomes.set(name, rs);
    prog(`  simulating ${name}`);
  }
  log("\n");

  // ── window spread ────────────────────────────────────────────────────────
  log("═".repeat(76));
  log(`SAMPLE SPREAD (${DAYS} days)`);
  for (const w of windowInfo) log(`  −${w.hoursAgo.toFixed(0).padStart(3)}h   ${String(w.launches).padStart(4)} launches`);

  // ── sweep ────────────────────────────────────────────────────────────────
  interface Row {
    filters: string; preset: string; n: number; closed: number; win: number;
    avg: number; med: number; net: number; stranded: number;
  }
  const table: Row[] = [];
  const inEth = Number(ETH_PER_TRADE);

  for (const mob of SWEEP.minOtherBuys) {
    for (const mliq of SWEEP.minLiquidityEth) {
      for (const mvel of SWEEP.minBuyVelocity) {
        const cfg: SniperConfig = {
          ...DEFAULT_CONFIG, ethAmount: ETH_PER_TRADE, delaySeconds: DELAY_SECONDS,
          minOtherBuys: mob, minLiquidityEth: mliq === 0 ? null : mliq,
          minBuyVelocity: mvel, maxCreatorTaxBps: 2000,
        };
        const pass: number[] = [];
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          const v = evaluateLaunch(
            {
              launch: {
                token: e.launch.token, curve: e.launch.curve, deployer: e.launch.deployer,
                pairToken: e.launch.pairToken, graduationThreshold: e.launch.threshold,
              },
              snapshot: e.snapshot, liquidityEth: e.liquidityEth,
              otherBuys: e.otherBuys, buyVelocity: e.buyVelocity,
            },
            cfg,
          );
          if (v.buy) pass.push(i);
        }
        if (pass.length < 15) continue; // too few to mean anything

        const fname = `buys≥${mob} liq≥${mliq} vel≥${mvel ?? "–"}`;
        for (const [pname, rs] of outcomes) {
          const sel = pass.map((i) => rs[i]);
          if (sel.length < 15) continue;
          // EVERY entered position counts. Positions still open at the end of
          // the window are marked to market — excluding them would only ever
          // discard losers (a no-stop strategy closes solely on wins), which
          // manufactures a spectacular fake win rate.
          const pnls = sel.map((r) => r.pnlPct);
          table.push({
            filters: fname, preset: pname,
            n: sel.length,
            closed: sel.filter((r) => r.kind === "closed").length,
            win: (pnls.filter((p) => p > 0).length / pnls.length) * 100,
            avg: pnls.reduce((a, b) => a + b, 0) / pnls.length,
            med: median(pnls),
            net: pnls.reduce((s, p) => s + (p / 100) * inEth, 0),
            stranded: sel.filter((r) => r.kind === "stranded").length,
          });
        }
      }
    }
  }

  table.sort((a, b) => b.net - a.net);
  log(`\n${"═".repeat(76)}`);
  log(`TOP 15 COMBINATIONS BY NET PnL   (${table.length} tested, min 15 positions each)`);
  log(`Every entered position counts; unclosed ones are marked to market.`);
  log(
    `${"filters".padEnd(26)}${"exit".padEnd(23)}${"n".padStart(5)}${"clsd".padStart(6)}` +
      `${"win".padStart(6)}${"avg".padStart(8)}${"med".padStart(8)}${"net ETH".padStart(10)}`,
  );
  for (const r of table.slice(0, 15)) {
    log(
      `${r.filters.padEnd(26)}${r.preset.padEnd(23)}${String(r.n).padStart(5)}${String(r.closed).padStart(6)}` +
        `${(r.win.toFixed(0) + "%").padStart(6)}${((r.avg >= 0 ? "+" : "") + r.avg.toFixed(1) + "%").padStart(8)}` +
        `${(r.med.toFixed(1) + "%").padStart(8)}` +
        `${((r.net >= 0 ? "+" : "") + r.net.toFixed(4)).padStart(10)}`,
    );
  }
  const profitable = table.filter((r) => r.net > 0);
  log(`\n${profitable.length} of ${table.length} combinations were net profitable.`);
  if (profitable.length) {
    log(`Worst tested: ${table[table.length - 1].filters} / ${table[table.length - 1].preset} ` +
      `→ ${table[table.length - 1].net.toFixed(4)} ETH`);
  }

  // ── the tail ─────────────────────────────────────────────────────────────
  // Measured on the preset with NO graduation exit — otherwise the exit fires
  // first and nothing can ever be recorded as reaching graduation.
  const anyRs = outcomes.get("Hold, no exits")!;
  const grads = anyRs.filter((r) => r.kind === "stranded");
  log(`\n${"═".repeat(76)}`);
  log(`THE TAIL`);
  log(`  ${grads.length} of ${entries.length} (${((grads.length / entries.length) * 100).toFixed(2)}%) reached graduation`);
  if (grads.length) {
    const gp = grads.map((r) => r.pnlPct);
    log(`  PnL at that point: median ${median(gp).toFixed(0)}%  best ${Math.max(...gp).toFixed(0)}%`);
  }
  log(
    `\nNotes: fills include the real fee + creator tax on both legs and our own price\n` +
      `impact. Entry ${DELAY_SECONDS}s after launch. Combos with <15 trades are excluded.\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
