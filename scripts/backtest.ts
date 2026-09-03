/**
 * Backtest the sniper filters + exit rules against real pons launch history.
 *
 *   npm run backtest                 # last 3000 launches
 *   npm run backtest -- --launches 8000 --eth 0.01 --delay 20
 *
 * Method: replay every CurveBuy/CurveSell on every launched curve, reconstruct
 * the exact reserve/price series from the event fields (the same delta maths the
 * live monitor uses), then run the REAL filter and exit-rule code over it. This
 * exercises production logic rather than a reimplementation of it.
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
  formatEther,
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

const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as Address;
const NATIVE = "0x0000000000000000000000000000000000000000";
const LOG_CHUNK = 2000n; // public RPC rejects wider no-address ranges
const MULTICALL_BATCH = 150;

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1]);
    if (Number.isFinite(n)) return n;
  }
  return dflt;
}

const TARGET_LAUNCHES = arg("launches", 3000);
const ETH_PER_TRADE = String(arg("eth", 0.01));
const DELAY_SECONDS = arg("delay", DEFAULT_CONFIG.delaySeconds);
/**
 * Ignore launches too close to the end of the range. Without this, positions
 * opened in the last minutes have no time to reach a take-profit but plenty to
 * hit a stop-loss, which biases every result downward.
 */
const MIN_FORWARD_MINUTES = arg("minforward", 30);

const PRESETS: Record<string, { tp: number | null; sl: number | null; trail: number | null }> = {
  Safe: { tp: 25, sl: 15, trail: null },
  Balanced: { tp: 50, sl: 25, trail: null },
  Moonshot: { tp: 150, sl: 50, trail: null },
  "Trailing 25%": { tp: null, sl: 50, trail: 25 },
  "Hold to graduation": { tp: null, sl: null, trail: null },
};

const client = createPublicClient({
  chain: robinhoodChain, // carries the multicall3 address
  transport: http(RPC, { batch: true, retryCount: 3, timeout: 30_000 }),
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
}
interface Trade {
  block: bigint;
  index: number;
  kind: "CurveBuy" | "CurveSell";
  buyer: string;
  quote: bigint; // quoteIn (buy) or quoteOut (sell)
  tokens: bigint; // tokensOut (buy) or tokensIn (sell)
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

function log(msg: string) {
  process.stdout.write(`${msg}\n`);
}

/** Walk back in LOG_CHUNK steps until we have enough launches. */
async function fetchLaunches(head: bigint): Promise<{ launches: Launch[]; fromBlock: bigint }> {
  const out: Launch[] = [];
  let to = head;
  while (out.length < TARGET_LAUNCHES && to > 0n) {
    const from = to - LOG_CHUNK + 1n > 0n ? to - LOG_CHUNK + 1n : 0n;
    const logs = await client.getLogs({ address: FACTORY, event: launchEvent, fromBlock: from, toBlock: to });
    for (const l of logs) {
      out.push({
        token: getAddress(l.args.token as string),
        curve: getAddress(l.args.curve as string),
        deployer: getAddress(l.args.deployer as string),
        pairToken: (l.args.pairToken as string).toLowerCase(),
        threshold: l.args.graduationThreshold as bigint,
        block: l.blockNumber!,
      });
    }
    process.stdout.write(`\r  launches: ${out.length}/${TARGET_LAUNCHES}   `);
    to = from - 1n;
  }
  process.stdout.write("\n");
  out.sort((a, b) => Number(a.block - b.block));
  const trimmed = out.slice(-TARGET_LAUNCHES);
  return { launches: trimmed, fromBlock: trimmed[0]?.block ?? head };
}

/** One pass over the range pulling every curve trade, grouped by curve. */
async function fetchTrades(fromBlock: bigint, head: bigint): Promise<Map<string, Trade[]>> {
  const byCurve = new Map<string, Trade[]>();
  let done = 0n;
  const span = head - fromBlock + 1n;
  for (let from = fromBlock; from <= head; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > head ? head : from + LOG_CHUNK - 1n;
    const raw = (await client.request({
      method: "eth_getLogs",
      params: [
        {
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${to.toString(16)}`,
          topics: [[T0_BUY, T0_SELL]],
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any[];

    const parsed = parseEventLogs({ abi: bondingCurveAbi, logs: raw });
    for (const e of parsed) {
      if (e.eventName !== "CurveBuy" && e.eventName !== "CurveSell") continue;
      const key = e.address.toLowerCase();
      const a = e.args as unknown as Record<string, bigint | string>;
      const t: Trade = {
        block: e.blockNumber!,
        index: e.logIndex!,
        kind: e.eventName,
        buyer: String(e.eventName === "CurveBuy" ? a.buyer : a.seller).toLowerCase(),
        quote: (e.eventName === "CurveBuy" ? a.quoteIn : a.quoteOut) as bigint,
        tokens: (e.eventName === "CurveBuy" ? a.tokensOut : a.tokensIn) as bigint,
        fee: a.fee as bigint,
        tax: a.tax as bigint,
      };
      const arr = byCurve.get(key);
      if (arr) arr.push(t);
      else byCurve.set(key, [t]);
    }
    done = to - fromBlock + 1n;
    process.stdout.write(
      `\r  trades: ${((Number(done) / Number(span)) * 100).toFixed(0)}%  (${byCurve.size} curves)   `,
    );
  }
  process.stdout.write("\n");
  for (const arr of byCurve.values()) {
    arr.sort((x, y) => (x.block === y.block ? x.index - y.index : Number(x.block - y.block)));
  }
  return byCurve;
}

/** Batch-read the immutables we need to reconstruct each curve. */
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
    const res = await client.multicall({ contracts, allowFailure: true });
    const N = 7;
    for (let j = 0; j < slice.length; j++) {
      const b = j * N;
      if (res[b].status !== "success" || res[b + 1].status !== "success") continue;
      const [qRes] = res[b].result as readonly [bigint, bigint];
      const real = res[b + 1].result as bigint;
      out.set(slice[j].curve.toLowerCase(), {
        // quoteReserve = phantom + real, and phantom is immutable
        phantom: qRes - real,
        feeBps: res[b + 2].status === "success" ? Number(res[b + 2].result) : 100,
        creatorTaxBps: res[b + 3].status === "success" ? Number(res[b + 3].result) : 0,
        supply: res[b + 4].status === "success" ? (res[b + 4].result as bigint) : 10n ** 27n,
        symbol: res[b + 5].status === "success" ? String(res[b + 5].result) : "???",
        decimals: res[b + 6].status === "success" ? Number(res[b + 6].result) : 18,
      });
    }
    process.stdout.write(
      `\r  metadata: ${Math.min(i + MULTICALL_BATCH, launches.length)}/${launches.length}   `,
    );
  }
  process.stdout.write("\n");
  return out;
}

/** Apply a trade to reserves — mirrors the live monitor's event delta maths. */
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

type Outcome =
  | { kind: "filtered"; reason: string }
  | { kind: "no-entry"; reason: string }
  | { kind: "closed"; reason: string; pnlPct: number; ethOut: number }
  | { kind: "stranded"; pnlAtGradPct: number }
  | { kind: "open-at-end"; markPnlPct: number };

function fakeRow(
  meta: CurveMeta,
  entryPrice: number,
  tokens: bigint,
  ethIn: bigint,
  threshold: bigint,
  preset: { tp: number | null; sl: number | null; trail: number | null },
  gradExit: number | null,
): PositionRow {
  return {
    id: "bt",
    status: "open",
    token_address: "0x",
    token_symbol: meta.symbol,
    token_decimals: meta.decimals,
    curve_address: "0x",
    pair_token: NATIVE,
    quote_symbol: "ETH",
    quote_decimals: 18,
    fee_bps: meta.feeBps,
    creator_tax_bps: meta.creatorTaxBps,
    quote_in_wei: ethIn.toString(),
    tokens_held_wei: tokens.toString(),
    entry_price: entryPrice,
    buy_tx: null,
    source: "sniper",
    take_profit_pct: preset.tp,
    stop_loss_pct: preset.sl,
    trailing_stop_pct: preset.trail,
    graduation_exit_pct: gradExit,
    graduation_threshold_wei: threshold.toString(),
    slippage_bps: 800,
    peak_price: entryPrice,
    last_price: entryPrice,
    last_checked_at: null,
    sell_attempts: 0,
    last_dry_run_at: null,
    exit_price: null,
    quote_out_wei: null,
    realised_pnl_pct: null,
    sell_tx: null,
    close_reason: null,
    error: null,
    created_at: "",
    updated_at: "",
  };
}

function simulate(
  launch: Launch,
  meta: CurveMeta,
  trades: Trade[],
  cfg: SniperConfig,
  preset: { tp: number | null; sl: number | null; trail: number | null },
  entryBlockDelay: bigint,
  gradExit: number | null,
): Outcome {
  const ethIn = parseEther(ETH_PER_TRADE);
  let reserves: CurveReserves = { quoteReserve: meta.phantom, tokenReserve: meta.supply };
  const entryBlock = launch.block + entryBlockDelay;

  // Replay up to the entry point.
  let i = 0;
  const buyers = new Set<string>();
  for (; i < trades.length && trades[i].block < entryBlock; i++) {
    const t = trades[i];
    if (t.kind === "CurveBuy" && t.buyer !== launch.deployer.toLowerCase()) buyers.add(t.buyer);
    reserves = applyTrade(reserves, t);
  }
  if (reserves.tokenReserve <= 0n || reserves.quoteReserve <= 0n) {
    return { kind: "no-entry", reason: "curve drained before entry" };
  }

  const realQuote = reserves.quoteReserve > meta.phantom ? reserves.quoteReserve - meta.phantom : 0n;
  const priceAtEntry = priceFromReserves(reserves, meta.decimals, 18);

  // Run the REAL sniper filter against reconstructed state.
  const snapshot = {
    symbol: meta.symbol,
    name: meta.symbol,
    decimals: meta.decimals,
    venue: "curve",
    tradeable: true,
    quoteIsNative: true,
    quoteSymbol: "ETH",
    creatorTaxBps: meta.creatorTaxBps,
    feeBps: meta.feeBps,
    reserves,
    price: priceAtEntry,
    graduation: {
      graduated: false,
      readyToGraduate: false,
      currentQuote: Number(realQuote) / 1e18,
      thresholdQuote: Number(launch.threshold) / 1e18,
      thresholdWei: launch.threshold,
      progressPct: graduationProgressPct(realQuote, launch.threshold.toString()) ?? 0,
    },
  } as unknown as TokenSnapshot;

  const verdict = evaluateLaunch(
    {
      launch: {
        token: launch.token,
        curve: launch.curve,
        deployer: launch.deployer,
        pairToken: launch.pairToken,
        graduationThreshold: launch.threshold,
      },
      snapshot,
      liquidityEth: Number(realQuote) / 1e18,
      otherBuys: buyers.size,
    },
    cfg,
  );
  if (!verdict.buy) return { kind: "filtered", reason: verdict.reason };

  // Simulate our own buy (and its impact on the curve).
  const q = quoteBuy(ethIn, reserves, BigInt(meta.feeBps), BigInt(meta.creatorTaxBps));
  if (q.tokensOut <= 0n) return { kind: "no-entry", reason: "zero fill" };
  const held = q.tokensOut;
  reserves = applyTrade(reserves, {
    block: entryBlock,
    index: 0,
    kind: "CurveBuy",
    buyer: "self",
    quote: ethIn,
    tokens: held,
    fee: q.fee,
    tax: q.tax,
  });

  const entryPrice = Number(ethIn) / 1e18 / (Number(held) / 10 ** meta.decimals);
  const row = fakeRow(meta, entryPrice, held, ethIn, launch.threshold, preset, gradExit);

  // Walk forward, evaluating the real exit rules after every trade.
  for (; i < trades.length; i++) {
    reserves = applyTrade(reserves, trades[i]);
    if (reserves.tokenReserve <= 0n || reserves.quoteReserve <= 0n) break;

    const price = priceFromReserves(reserves, meta.decimals, 18).priceQuote;
    const rq = reserves.quoteReserve > meta.phantom ? reserves.quoteReserve - meta.phantom : 0n;
    const gradPct = graduationProgressPct(rq, launch.threshold.toString());

    const decision = evaluateExit(row, { price, graduationPct: gradPct });
    row.peak_price = decision.peakPrice;
    row.last_price = price;

    if (decision.shouldExit && decision.reason) {
      const s = quoteSell(held, reserves, BigInt(meta.feeBps), BigInt(meta.creatorTaxBps));
      const ethOut = Number(s.quoteOut) / 1e18;
      const inEth = Number(ethIn) / 1e18;
      return {
        kind: "closed",
        reason: decision.reason,
        pnlPct: ((ethOut - inEth) / inEth) * 100,
        ethOut,
      };
    }

    // Past the threshold the curve stops selling — a real stranded bag.
    if (rq >= launch.threshold) {
      const s = quoteSell(held, reserves, BigInt(meta.feeBps), BigInt(meta.creatorTaxBps));
      const inEth = Number(ethIn) / 1e18;
      return { kind: "stranded", pnlAtGradPct: ((Number(s.quoteOut) / 1e18 - inEth) / inEth) * 100 };
    }
  }

  const s = quoteSell(held, reserves, BigInt(meta.feeBps), BigInt(meta.creatorTaxBps));
  const inEth = Number(ethIn) / 1e18;
  return { kind: "open-at-end", markPnlPct: ((Number(s.quoteOut) / 1e18 - inEth) / inEth) * 100 };
}

function pct(n: number, d: number): string {
  return d === 0 ? "–" : `${((n / d) * 100).toFixed(0)}%`;
}
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main() {
  log(`\npons backtest — ${TARGET_LAUNCHES} launches, ${ETH_PER_TRADE} ETH/trade, ${DELAY_SECONDS}s entry delay`);
  log(`RPC ${RPC}\n`);

  const head = await client.getBlockNumber();
  log("fetching…");
  const { launches, fromBlock } = await fetchLaunches(head);

  // calibrate block time so the entry delay is in the right units
  const [b1, b2] = await Promise.all([
    client.getBlock({ blockNumber: head }),
    client.getBlock({ blockNumber: fromBlock }),
  ]);
  const blockSecs = Number(b1.timestamp - b2.timestamp) / Number(head - fromBlock);
  const entryBlockDelay = BigInt(Math.max(1, Math.round(DELAY_SECONDS / blockSecs)));
  const hours = (Number(head - fromBlock) * blockSecs) / 3600;

  const allNative = launches.filter((l) => l.pairToken === NATIVE);
  // Only trade launches that have MIN_FORWARD_MINUTES of history after them.
  const forwardBlocks = BigInt(Math.round((MIN_FORWARD_MINUTES * 60) / blockSecs));
  const cutoff = head - forwardBlocks;
  const native = allNative.filter((l) => l.block <= cutoff);
  const tooRecent = allNative.length - native.length;

  log(
    `\n${launches.length} launches over ${hours.toFixed(1)}h (block time ${blockSecs.toFixed(3)}s)\n` +
      `${allNative.length} native-ETH (${pct(allNative.length, launches.length)}) — the rest are ` +
      `USDG/stock-quoted and not tradeable by this engine yet\n` +
      `${tooRecent} dropped for having <${MIN_FORWARD_MINUTES}min of forward data ` +
      `(they could hit a stop but never a target)\n` +
      `${native.length} simulated · entry delay ${DELAY_SECONDS}s ≈ ${entryBlockDelay} blocks\n`,
  );

  const trades = await fetchTrades(fromBlock, head);
  const meta = await fetchMeta(native);
  log("");

  const cfg: SniperConfig = { ...DEFAULT_CONFIG, ethAmount: ETH_PER_TRADE, delaySeconds: DELAY_SECONDS };

  // Filter funnel is preset-independent — report it once.
  let filteredOut = 0;
  const filterReasons = new Map<string, number>();

  const rows: string[] = [];
  for (const [name, preset] of Object.entries(PRESETS)) {
    const closed: Outcome[] = [];
    let stranded = 0;
    let openAtEnd = 0;
    let noEntry = 0;
    let considered = 0;
    const strandedPnls: number[] = [];
    const openPnls: number[] = [];
    const byReason = new Map<string, number>();

    for (const l of native) {
      const m = meta.get(l.curve.toLowerCase());
      if (!m) continue;
      const t = trades.get(l.curve.toLowerCase()) ?? [];
      considered++;
      const gradExit = name === "Hold to graduation" ? null : DEFAULT_CONFIG.graduationExitPct;
      const o = simulate(l, m, t, cfg, preset, entryBlockDelay, gradExit);
      if (o.kind === "filtered") {
        if (name === "Safe") {
          filteredOut++;
          filterReasons.set(o.reason, (filterReasons.get(o.reason) ?? 0) + 1);
        }
        continue;
      }
      if (o.kind === "no-entry") { noEntry++; continue; }
      if (o.kind === "stranded") { stranded++; strandedPnls.push(o.pnlAtGradPct); continue; }
      if (o.kind === "open-at-end") { openAtEnd++; openPnls.push(o.markPnlPct); continue; }
      closed.push(o);
      byReason.set(o.reason, (byReason.get(o.reason) ?? 0) + 1);
    }

    const pnls = closed.map((o) => (o.kind === "closed" ? o.pnlPct : 0));
    const wins = pnls.filter((p) => p > 0).length;
    const ethIn = Number(ETH_PER_TRADE);
    const totalPnlEth = closed.reduce(
      (s, o) => s + (o.kind === "closed" ? o.ethOut - ethIn : 0),
      0,
    );
    const avg = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;

    rows.push(
      `\n── ${name} ${preset.tp ? `TP +${preset.tp}% ` : ""}${preset.sl ? `SL −${preset.sl}% ` : ""}` +
        `${preset.trail ? `trail ${preset.trail}% ` : ""}${name === "Hold to graduation" ? "(no exits)" : ""}\n` +
        `   trades ${closed.length}   win rate ${pct(wins, pnls.length)}   ` +
        `avg ${avg >= 0 ? "+" : ""}${avg.toFixed(1)}%   median ${median(pnls).toFixed(1)}%\n` +
        `   net ${totalPnlEth >= 0 ? "+" : ""}${totalPnlEth.toFixed(4)} ETH on ` +
        `${(closed.length * ethIn).toFixed(2)} ETH deployed\n` +
        `   exits: ${[...byReason.entries()].map(([r, n]) => `${r} ${n}`).join(", ") || "none"}\n` +
        `   stranded past graduation ${stranded}` +
        `${strandedPnls.length ? ` (avg ${median(strandedPnls).toFixed(0)}% at that point)` : ""}` +
        `   still open at end ${openAtEnd}` +
        `${openPnls.length ? ` (median ${median(openPnls).toFixed(0)}%)` : ""}` +
        `   no entry ${noEntry}   considered ${considered}`,
    );
  }

  log(`\n${"═".repeat(78)}`);
  log(`FILTER FUNNEL (default sniper config)`);
  log(`  ${native.length} native-ETH launches → ${native.length - filteredOut} passed filters`);
  for (const [r, n] of [...filterReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    log(`    ${String(n).padStart(5)}  ${r}`);
  }
  log(`${"═".repeat(78)}`);
  for (const r of rows) log(r);
  log(
    `\nNotes: fills include the real fee+creator-tax on both legs and our own price\n` +
      `impact. Entry is ${DELAY_SECONDS}s after launch (past the anti-snipe-tax window).\n` +
      `"Stranded" = the curve graduated before an exit fired, which is a bag this\n` +
      `engine cannot currently sell.\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
