/**
 * Streaming scan of ALL pons launches over a period, into data/scan.sqlite.
 *
 *   npm run scan                    # last 5 days
 *   npm run scan -- --days 5 --rps 4
 *
 * Scan once, analyse many times. Every later question (dev reputation, early
 * buyers, dip-then-rip, preset sweeps) reads the sqlite rather than re-scanning.
 *
 * Memory: raw events are applied to a small per-curve state and DISCARDED
 * immediately — the exit rules run incrementally as events stream past, exactly
 * as the live monitor does, so nothing needs the price path stored. Curves are
 * retired once they've been silent for a while (dead is proven by silence, not
 * by an early low price — a token can look dead at 20s and rip later).
 * ~130k launches ends up around 30MB rather than ~3GB.
 *
 * Curve parameters are derived, not read: pons v2 always mints exactly 1e27 and
 * seeds a 1.68 ETH phantom reserve (both verified against live contracts), which
 * removes ~900 multicalls.
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
import {
  createPublicClient,
  http,
  parseAbiItem,
  parseEventLogs,
  keccak256,
  toHex,
  parseEther,
  type Address,
} from "viem";
import { bondingCurveAbi } from "../src/lib/pons/abis";
import { quoteBuy, quoteSell, priceFromReserves, type CurveReserves } from "../src/lib/pons/pricing";

const RPC = process.env.BACKTEST_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as Address;
const NATIVE = "0x0000000000000000000000000000000000000000";
const LOG_CHUNK = 2000n;

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1]);
    if (Number.isFinite(n)) return n;
  }
  return dflt;
}
const DAYS = arg("days", 5);
const RPS = arg("rps", 4);
const ETH_IN = parseEther(String(arg("eth", 0.01)));
const DELAY_SECONDS = arg("delay", 20);

/**
 * snipe — enter every native launch DELAY_SECONDS after it deploys (the
 *         original sweep; established that blind sniping loses on every exit).
 * dip   — never enter at launch. Wait for a drawdown off a local high while the
 *         curve holds a given amount of liquidity, then enter. Each entry rule
 *         runs its own independent book, so one pass prices the whole grid.
 */
const MODE = (() => {
  const i = process.argv.indexOf("--mode");
  const v = i >= 0 ? process.argv[i + 1] : "snipe";
  if (v !== "snipe" && v !== "dip") throw new Error(`--mode must be snipe|dip, got ${v}`);
  return v;
})();
const OUT = MODE === "dip" ? "./data/scan-dip.sqlite" : "./data/scan.sqlite";

/** Verified constants — see the derivation validation in the commit message. */
const SUPPLY = 10n ** 27n;
const PHANTOM = 1_680_000_000_000_000_000n; // 1.68 ETH
const FEE_BPS = 100n;
/** Retire a curve after this many blocks of silence (~30 min at 0.102s). */
const RETIRE_BLOCKS = 17_000n;
/** Cap on early-buyer wallets recorded per token. */
const EARLY_BUYERS = 20;

const PRESETS: { name: string; tp: number | null; sl: number | null; trail: number | null; grad: number | null }[] = [
  { name: "safe", tp: 25, sl: 15, trail: null, grad: 92 },
  { name: "balanced", tp: 50, sl: 25, trail: null, grad: 92 },
  { name: "moonshot", tp: 150, sl: 50, trail: null, grad: 92 },
  { name: "wide", tp: 300, sl: 80, trail: null, grad: 92 },
  { name: "tp50", tp: 50, sl: null, trail: null, grad: 92 },
  { name: "tp100", tp: 100, sl: null, trail: null, grad: 92 },
  { name: "trail25", tp: null, sl: null, trail: 25, grad: 92 },
  { name: "trail40", tp: null, sl: null, trail: 40, grad: 92 },
  { name: "hold", tp: null, sl: null, trail: null, grad: null },
];

/**
 * Dip-entry rules, evaluated on every trade with no lookahead: at this tick,
 * how far are we off the running local high, and how much real ETH is in the
 * curve right now? The first tick that satisfies a rule enters it, once.
 *
 * The `nodip_*` rules are CONTROLS: same liquidity band, no drawdown required.
 * If they earn as much as their dip counterpart then the dip is worthless and
 * the only real signal is "this curve attracted money" — which we must know
 * before building anything around dip-buying.
 * `dip25_any` is the other control: the dip with no liquidity filter at all.
 */
const ENTRIES: { name: string; dip: number; liqMin: number; liqMax: number }[] = [
  { name: "dip25_lo", dip: 25, liqMin: 0.1, liqMax: 0.5 },
  { name: "dip25_mid", dip: 25, liqMin: 0.5, liqMax: 1.0 },
  { name: "dip25_hi", dip: 25, liqMin: 1.0, liqMax: 2.0 },
  { name: "dip40_mid", dip: 40, liqMin: 0.5, liqMax: 1.0 },
  { name: "dip40_hi", dip: 40, liqMin: 1.0, liqMax: 2.0 },
  { name: "dip25_wide", dip: 25, liqMin: 0.5, liqMax: 2.0 },
  { name: "dip50_wide", dip: 50, liqMin: 0.5, liqMax: 2.0 },
  { name: "nodip_mid", dip: 0, liqMin: 0.5, liqMax: 1.0 },
  { name: "nodip_hi", dip: 0, liqMin: 1.0, liqMax: 2.0 },
  { name: "dip25_any", dip: 25, liqMin: 0, liqMax: 1e9 },
];

const client = createPublicClient({ transport: http(RPC, { retryCount: 3, timeout: 30_000 }) });
const launchEvent = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
);
const T0_BUY = keccak256(toHex("CurveBuy(address,address,uint256,uint256,uint256,uint256)"));
const T0_SELL = keccak256(toHex("CurveSell(address,address,uint256,uint256,uint256,uint256)"));

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
      if ((!s.includes("429") && !/too many requests/i.test(s)) || attempt >= 6) throw e;
      await sleep(Math.min(30_000, 1000 * 2 ** attempt));
    }
  }
}

interface Sim {
  /** Book name. In dip mode "<entry>/<exit>", in snipe mode just the exit. */
  name: string;
  /** Index into PRESETS — the exit rule this book is running. */
  exitIdx: number;
  entryPrice: number;
  entryLiq: number;
  held: bigint;
  peak: number;
  closed: boolean;
  reason: string;
  pnlPct: number;
}
interface Curve {
  token: string;
  deployer: string;
  threshold: bigint;
  launchBlock: bigint;
  native: boolean;
  taxBps: bigint | null;
  quoteReserve: bigint;
  tokenReserve: bigint;
  trades: number;
  buys: number;
  sells: number;
  buyers: Set<string>;
  earlyBuyers: string[];
  buysBeforeEntry: number;
  peakRealQuote: bigint;
  peakPrice: number;

  /**
   * Best dip-then-rip cycle: pump to a local peak, dump, then run back up.
   *
   * Tracked as a rolling cycle rather than "drawdown from the all-time high" —
   * the rip we care about usually SETS a new high, so anchoring on the ATH would
   * erase exactly the pattern we're looking for.
   */
  cyclePeak: number; // local high the current dip is measured from
  cycleLow: number; // lowest price since that high
  cycleLowLiq: number; // liquidity (ETH) at that low — "would I have bought here?"
  bestDipDepth: number; // % drop from local peak to the low, for the best cycle
  bestRipFromDip: number; // % gain off that low
  bestDipLiq: number; // liquidity at the low of the best cycle
  blocksToPeak: number;
  graduated: boolean;
  lastActive: bigint;
  entered: boolean;
  entryPrice: number;
  entryLiquidity: number;
  entryVelocity: number;
  sims: Sim[] | null;
  /** dip mode: which entry rules have already fired for this curve. */
  dipFired: boolean[] | null;
}

const curves = new Map<string, Curve>();
let launchCount = 0;
let retired = 0;
let eventCount = 0;
let feeAnomalies = 0;

// ── output db ────────────────────────────────────────────────────────────────
try {
  mkdirSync("./data", { recursive: true });
} catch {
  /* exists */
}
const db = new DatabaseSync(OUT);
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`DROP TABLE IF EXISTS launches; DROP TABLE IF EXISTS early_buyers; DROP TABLE IF EXISTS sims;`);
db.exec(`
  CREATE TABLE launches (
    token TEXT PRIMARY KEY, curve TEXT, deployer TEXT, launch_block INTEGER,
    native INTEGER, tax_bps INTEGER, threshold_eth REAL,
    trades INTEGER, buys INTEGER, sells INTEGER, unique_buyers INTEGER,
    peak_liq_eth REAL, final_liq_eth REAL, peak_price REAL,
    best_dip_depth REAL, best_rip_from_dip REAL, best_dip_liq_eth REAL,
    blocks_to_peak INTEGER,
    graduated INTEGER, lifetime_blocks INTEGER,
    entered INTEGER, entry_price REAL, entry_liq_eth REAL,
    entry_other_buys INTEGER, entry_velocity REAL
  );
  CREATE TABLE early_buyers (token TEXT, idx INTEGER, wallet TEXT);
  CREATE TABLE sims (
    token TEXT, preset TEXT, closed INTEGER, reason TEXT, pnl_pct REAL,
    entry_liq REAL, entry_price REAL
  );
  CREATE INDEX i_lb ON launches(launch_block);
  CREATE INDEX i_dep ON launches(deployer);
  CREATE INDEX i_eb ON early_buyers(wallet);
  CREATE INDEX i_sim ON sims(preset);
`);
const insLaunch = db.prepare(
  `INSERT OR REPLACE INTO launches VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
);
const insBuyer = db.prepare(`INSERT INTO early_buyers VALUES (?,?,?)`);
const insSim = db.prepare(`INSERT INTO sims VALUES (?,?,?,?,?,?,?)`);

function priceOf(r: CurveReserves): number {
  return priceFromReserves(r, 18, 18).priceQuote;
}

/** Only count a dip this deep as a real "dump", not noise. */
const MIN_DIP_DEPTH_PCT = 25;

/**
 * Advance the rolling dip-then-rip cycle.
 *
 * A cycle is: local peak -> dump -> run back up. We keep the BEST (largest rip)
 * cycle seen, along with how deep the preceding dump was and how much liquidity
 * sat in the curve at the low — i.e. "could I have bought that dip, and what
 * would it have paid?".
 */
function recordCycle(c: Curve, p: number, liq: number): void {
  if (p <= 0) return;
  if (c.cyclePeak === 0) {
    c.cyclePeak = p;
    c.cycleLow = p;
    c.cycleLowLiq = liq;
    return;
  }
  if (p < c.cycleLow) {
    c.cycleLow = p;
    c.cycleLowLiq = liq;
  }
  const depth = ((c.cyclePeak - c.cycleLow) / c.cyclePeak) * 100;
  const rip = c.cycleLow > 0 ? ((p - c.cycleLow) / c.cycleLow) * 100 : 0;
  if (depth >= MIN_DIP_DEPTH_PCT && rip > c.bestRipFromDip) {
    c.bestRipFromDip = rip;
    c.bestDipDepth = depth;
    c.bestDipLiq = c.cycleLowLiq;
  }
  // A new high closes this cycle and starts the next one from here.
  if (p > c.cyclePeak) {
    c.cyclePeak = p;
    c.cycleLow = p;
    c.cycleLowLiq = liq;
  }
}
function realQuote(c: Curve): bigint {
  return c.quoteReserve > PHANTOM ? c.quoteReserve - PHANTOM : 0n;
}

function flush(key: string, c: Curve): void {
  const lifetime = Number(c.lastActive - c.launchBlock);
  insLaunch.run(
    c.token, key, c.deployer, Number(c.launchBlock),
    c.native ? 1 : 0, Number(c.taxBps ?? 0), Number(c.threshold) / 1e18,
    c.trades, c.buys, c.sells, c.buyers.size,
    Number(c.peakRealQuote) / 1e18, Number(realQuote(c)) / 1e18, c.peakPrice,
    c.bestDipDepth, c.bestRipFromDip, c.bestDipLiq, c.blocksToPeak,
    c.graduated ? 1 : 0, lifetime,
    c.entered ? 1 : 0, c.entryPrice, c.entryLiquidity,
    c.buysBeforeEntry, c.entryVelocity,
  );
  for (let i = 0; i < c.earlyBuyers.length; i++) insBuyer.run(c.token, i, c.earlyBuyers[i]);
  if (c.sims) {
    for (const s of c.sims) {
      insSim.run(c.token, s.name, s.closed ? 1 : 0, s.reason, s.pnlPct, s.entryLiq, s.entryPrice);
    }
  }
  curves.delete(key);
  retired++;
}

/** Open the simulated positions for this curve at its entry point. */
function enterSims(c: Curve, blockSecs: number, delayBlocks: bigint): void {
  const res: CurveReserves = { quoteReserve: c.quoteReserve, tokenReserve: c.tokenReserve };
  const q = quoteBuy(ETH_IN, res, FEE_BPS, c.taxBps ?? 0n);
  if (q.tokensOut <= 0n) return;
  c.entered = true;
  c.entryLiquidity = Number(realQuote(c)) / 1e18;
  c.entryVelocity = c.buysBeforeEntry / (Number(delayBlocks) * blockSecs);
  // Our own buy moves the curve.
  c.quoteReserve += ETH_IN - q.fee - q.tax;
  c.tokenReserve -= q.tokensOut;
  c.entryPrice = Number(ETH_IN) / 1e18 / (Number(q.tokensOut) / 1e18);
  c.sims = PRESETS.map((p, i) => ({
    name: p.name, exitIdx: i,
    entryPrice: c.entryPrice, entryLiq: c.entryLiquidity,
    held: q.tokensOut, peak: c.entryPrice,
    closed: false, reason: "", pnlPct: 0,
  }));
}

/**
 * dip mode: open a book per exit rule for entry rule `ei`, at the current tick.
 *
 * Unlike snipe mode this does NOT move the shared curve. Ten entry rules fire at
 * ten different moments; applying each one's buy to the common reserves would
 * stack ten phantom purchases and corrupt every other book. Our own price impact
 * is still paid — quoteBuy prices the order against the live reserves — we just
 * don't leave it behind for the others to trade against.
 */
function openDipEntry(c: Curve, ei: number, liq: number): void {
  const res: CurveReserves = { quoteReserve: c.quoteReserve, tokenReserve: c.tokenReserve };
  const q = quoteBuy(ETH_IN, res, FEE_BPS, c.taxBps ?? 0n);
  if (q.tokensOut <= 0n) return;
  c.dipFired![ei] = true;
  const entryPrice = Number(ETH_IN) / 1e18 / (Number(q.tokensOut) / 1e18);
  if (!c.sims) c.sims = [];
  for (let xi = 0; xi < PRESETS.length; xi++) {
    c.sims.push({
      name: `${ENTRIES[ei].name}/${PRESETS[xi].name}`, exitIdx: xi,
      entryPrice, entryLiq: liq, held: q.tokensOut, peak: entryPrice,
      closed: false, reason: "", pnlPct: 0,
    });
  }
}

/**
 * Check every dip rule that has not yet fired against this tick.
 *
 * Must be called BEFORE recordCycle, so `cyclePeak` is still the previous local
 * high — that is the high a live bot would be measuring its drawdown against.
 */
function checkDipEntries(c: Curve, price: number, liq: number): void {
  if (!c.native || !c.dipFired || c.cyclePeak <= 0 || price <= 0) return;
  const drawdown = ((c.cyclePeak - price) / c.cyclePeak) * 100;
  for (let ei = 0; ei < ENTRIES.length; ei++) {
    if (c.dipFired[ei]) continue;
    const r = ENTRIES[ei];
    if (drawdown < r.dip) continue;
    if (liq < r.liqMin || liq > r.liqMax) continue;
    openDipEntry(c, ei, liq);
  }
}

/** Advance every open sim on this curve after a trade. */
function stepSims(c: Curve): void {
  if (!c.sims) return;
  const res: CurveReserves = { quoteReserve: c.quoteReserve, tokenReserve: c.tokenReserve };
  if (res.quoteReserve <= 0n || res.tokenReserve <= 0n) return;
  const price = priceOf(res);
  const rq = realQuote(c);
  const gradPct = c.threshold > 0n ? (Number(rq) / Number(c.threshold)) * 100 : 0;
  const inEth = Number(ETH_IN) / 1e18;

  for (const s of c.sims) {
    if (s.closed) continue;
    const p = PRESETS[s.exitIdx];
    if (price > s.peak) s.peak = price;
    const pnl = ((price - s.entryPrice) / s.entryPrice) * 100;

    let reason = "";
    if (p.sl != null && pnl <= -p.sl) reason = "stop_loss";
    else if (p.grad != null && gradPct >= p.grad) reason = "graduation_exit";
    else if (p.tp != null && pnl >= p.tp) reason = "take_profit";
    else if (p.trail != null && ((price - s.peak) / s.peak) * 100 <= -p.trail) reason = "trailing_stop";
    else if (rq >= c.threshold) reason = "stranded";

    if (reason) {
      const out = quoteSell(s.held, res, FEE_BPS, c.taxBps ?? 0n);
      s.closed = reason !== "stranded";
      s.reason = reason;
      s.pnlPct = ((Number(out.quoteOut) / 1e18 - inEth) / inEth) * 100;
    }
  }
}

/** Mark any still-open sims to market when the curve retires. */
function settleSims(c: Curve): void {
  if (!c.sims) return;
  const res: CurveReserves = { quoteReserve: c.quoteReserve, tokenReserve: c.tokenReserve };
  const inEth = Number(ETH_IN) / 1e18;
  for (const s of c.sims) {
    if (s.closed || s.reason) continue;
    s.reason = "open_at_end";
    if (res.quoteReserve > 0n && res.tokenReserve > 0n) {
      const out = quoteSell(s.held, res, FEE_BPS, c.taxBps ?? 0n);
      s.pnlPct = ((Number(out.quoteOut) / 1e18 - inEth) / inEth) * 100;
    } else {
      s.pnlPct = -100;
    }
  }
}

async function main() {
  const head = await rpc(() => client.getBlockNumber());
  const hb = await rpc(() => client.getBlock({ blockNumber: head }));
  const pb = await rpc(() => client.getBlock({ blockNumber: head - 50_000n }));
  const blockSecs = Number(hb.timestamp - pb.timestamp) / 50_000;
  const spanBlocks = BigInt(Math.round((DAYS * 86400) / blockSecs));
  const start = head - spanBlocks;
  const delayBlocks = BigInt(Math.max(1, Math.round(DELAY_SECONDS / blockSecs)));
  const totalChunks = Number(spanBlocks / LOG_CHUNK) + 1;

  console.log(`\npons full scan — ${DAYS} days`);
  console.log(`RPC ${RPC}`);
  console.log(`blocks ${start} → ${head} (${spanBlocks}, block time ${blockSecs.toFixed(3)}s)`);
  console.log(`${totalChunks} chunks × 2 requests at ${RPS}/s → ~${((totalChunks * 2) / RPS / 60).toFixed(0)} min`);
  console.log(
    MODE === "dip"
      ? `mode dip — ${ENTRIES.length} entry rules × ${PRESETS.length} exits, ${Number(ETH_IN) / 1e18} ETH\n`
      : `mode snipe — entry ${DELAY_SECONDS}s (${delayBlocks} blocks) after launch, ${Number(ETH_IN) / 1e18} ETH\n`,
  );

  const t0 = Date.now();
  let chunk = 0;

  for (let from = start; from <= head; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > head ? head : from + LOG_CHUNK - 1n;
    chunk++;

    // 1. new launches in this range
    const lg = await rpc(() =>
      client.getLogs({ address: FACTORY, event: launchEvent, fromBlock: from, toBlock: to }),
    );
    for (const l of lg) {
      const key = (l.args.curve as string).toLowerCase();
      curves.set(key, {
        token: (l.args.token as string).toLowerCase(),
        deployer: (l.args.deployer as string).toLowerCase(),
        threshold: l.args.graduationThreshold as bigint,
        launchBlock: l.blockNumber!,
        native: (l.args.pairToken as string).toLowerCase() === NATIVE,
        taxBps: null,
        quoteReserve: PHANTOM,
        tokenReserve: SUPPLY,
        trades: 0, buys: 0, sells: 0,
        buyers: new Set(), earlyBuyers: [], buysBeforeEntry: 0,
        peakRealQuote: 0n, peakPrice: 0,
        cyclePeak: 0, cycleLow: 0, cycleLowLiq: 0,
        bestDipDepth: 0, bestRipFromDip: 0, bestDipLiq: 0, blocksToPeak: 0,
        graduated: false, lastActive: l.blockNumber!,
        entered: false, entryPrice: 0, entryLiquidity: 0, entryVelocity: 0,
        sims: null,
        dipFired: MODE === "dip" ? new Array(ENTRIES.length).fill(false) : null,
      });
      launchCount++;
    }

    // 2. every curve trade in this range
    const raw = (await rpc(() =>
      client.request({
        method: "eth_getLogs",
        params: [
          {
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
            topics: [[T0_BUY, T0_SELL]],
          },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }),
    )) as any[];
    const evs = parseEventLogs({ abi: bondingCurveAbi, logs: raw });

    for (const e of evs) {
      if (e.eventName !== "CurveBuy" && e.eventName !== "CurveSell") continue;
      const key = e.address.toLowerCase();
      const c = curves.get(key);
      if (!c) continue; // launched before our window — not our sample
      eventCount++;
      const a = e.args as unknown as Record<string, bigint | string>;
      c.lastActive = e.blockNumber!;
      c.trades++;

      if (e.eventName === "CurveBuy") {
        const quoteIn = a.quoteIn as bigint;
        const fee = a.fee as bigint;
        const tax = a.tax as bigint;
        const tokensOut = a.tokensOut as bigint;
        // Derive the creator tax once, from the first buy. Integer rounding in
        // the contract means the raw ratio can be off by a bp, so snap it to the
        // nearest 50 — creator taxes are always chosen in round numbers.
        if (c.taxBps === null && quoteIn > 0n) {
          const rawTax = Number((tax * 10_000n) / quoteIn);
          c.taxBps = BigInt(Math.round(rawTax / 50) * 50);
          // Only sanity-check the fee against a buy big enough for the ratio to
          // mean anything — the contract floor-divides, so a dust buy can imply
          // any bps at all. Below 0.001 ETH the rounding dominates entirely.
          if (quoteIn > 1_000_000_000_000_000n) {
            const rawFee = Number((fee * 10_000n) / quoteIn);
            if (Math.abs(rawFee - 100) > 15) feeAnomalies++;
          }
        }
        const buyer = String(a.buyer).toLowerCase();
        c.buys++;
        if (buyer !== c.deployer) {
          if (!c.buyers.has(buyer)) {
            c.buyers.add(buyer);
            if (c.earlyBuyers.length < EARLY_BUYERS) c.earlyBuyers.push(buyer);
          }
          if (!c.entered && e.blockNumber! < c.launchBlock + delayBlocks) c.buysBeforeEntry++;
        }
        const net = quoteIn - fee - tax;
        c.quoteReserve += net > 0n ? net : 0n;
        c.tokenReserve = c.tokenReserve > tokensOut ? c.tokenReserve - tokensOut : 0n;
      } else {
        const gross = (a.quoteOut as bigint) + (a.fee as bigint) + (a.tax as bigint);
        c.sells++;
        c.quoteReserve = c.quoteReserve > gross ? c.quoteReserve - gross : 0n;
        c.tokenReserve += a.tokensIn as bigint;
      }

      // enter once we're past the delay
      if (MODE === "snipe" && !c.entered && c.native && e.blockNumber! >= c.launchBlock + delayBlocks) {
        enterSims(c, blockSecs, delayBlocks);
      }

      // track peak / dip-then-rip shape
      if (c.quoteReserve > 0n && c.tokenReserve > 0n) {
        const rq = realQuote(c);
        if (rq > c.peakRealQuote) c.peakRealQuote = rq;
        if (rq >= c.threshold) c.graduated = true;
        const p = priceOf({ quoteReserve: c.quoteReserve, tokenReserve: c.tokenReserve });
        const liq = Number(rq) / 1e18;
        if (p > c.peakPrice) {
          c.peakPrice = p;
          c.blocksToPeak = Number(e.blockNumber! - c.launchBlock);
        }
        // Before recordCycle: cyclePeak is still the high we are dipping from.
        if (MODE === "dip") checkDipEntries(c, p, liq);
        recordCycle(c, p, liq);
      }
      stepSims(c);
    }

    // 3. retire silent curves — dead is proven by silence, not an early low
    if (chunk % 5 === 0) {
      const cutoff = to - RETIRE_BLOCKS;
      for (const [k, c] of curves) {
        if (c.lastActive < cutoff) {
          settleSims(c);
          flush(k, c);
        }
      }
    }

    if (chunk % 10 === 0 || chunk === totalChunks) {
      const pctDone = (chunk / totalChunks) * 100;
      const elapsed = (Date.now() - t0) / 1000;
      const eta = elapsed / (pctDone / 100) - elapsed;
      const mem = process.memoryUsage().heapUsed / 1024 / 1024;
      process.stdout.write(
        `\r  ${pctDone.toFixed(1)}%  launches ${launchCount}  live ${curves.size}  ` +
          `retired ${retired}  events ${(eventCount / 1000).toFixed(0)}k  ` +
          `heap ${mem.toFixed(0)}MB  eta ${(eta / 60).toFixed(0)}min    `,
      );
    }
  }

  for (const [k, c] of curves) {
    settleSims(c);
    flush(k, c);
  }

  const secs = (Date.now() - t0) / 1000;
  console.log(`\n\ndone in ${(secs / 60).toFixed(1)} min`);
  console.log(`  launches   ${launchCount}`);
  console.log(`  events     ${eventCount}`);
  console.log(`  fee anomalies ${feeAnomalies} (expected ~0)`);
  const row = db.prepare(
    `SELECT COUNT(*) n, SUM(native) nat, SUM(entered) ent, SUM(graduated) grad FROM launches`,
  ).get() as Record<string, number>;
  console.log(`  rows       ${row.n}  native ${row.nat}  entered ${row.ent}  graduated ${row.grad}`);

  if (MODE === "dip") {
    // Every book is 0.01 ETH per entry, so net ETH is directly comparable
    // across rules even though each rule fires a different number of times.
    const inEth = Number(ETH_IN) / 1e18;
    const rows = db.prepare(
      `SELECT preset, COUNT(*) n,
              AVG(pnl_pct) avg_pnl,
              SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) wins,
              SUM(pnl_pct) / 100.0 * ? net
       FROM sims GROUP BY preset ORDER BY net DESC`,
    ).all(inEth) as unknown as Record<string, number | string>[];

    console.log(`\n  DIP-ENTRY GRID — every book enters ${inEth} ETH per signal`);
    console.log(`  ${"book".padEnd(22)}${"n".padStart(7)}${"win".padStart(8)}${"avg".padStart(9)}${"net ETH".padStart(11)}`);
    for (const r of rows) {
      const n = Number(r.n);
      console.log(
        `  ${String(r.preset).padEnd(22)}${String(n).padStart(7)}` +
          `${((Number(r.wins) / n) * 100).toFixed(2).padStart(7)}%` +
          `${Number(r.avg_pnl).toFixed(1).padStart(8)}%` +
          `${Number(r.net).toFixed(4).padStart(11)}`,
      );
    }
  }
  console.log(`\nwritten to ${OUT}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
