import { getAddress, type Address, type Log } from "viem";
import { env } from "../env";
import { isWebSocket, publicClient, readClient } from "../chain";
import { logEngine, pruneEngineLog } from "../db/index";
import {
  claimForClosing,
  getPosition,
  listOpenPositions,
  updatePosition,
  type CloseReason,
  type PositionRow,
} from "../db/positions";
import { bondingCurveAbi } from "../pons/abis";
import { priceFromReserves, type CurveReserves } from "../pons/pricing";
import { evaluateExit, graduationProgressPct, type ExitInputs } from "./rules";
import { closePosition } from "./executor";
import { isLive } from "./liveState";
import { hasBotWallet } from "../wallet/botWallet";

/**
 * Event-driven exit monitor.
 *
 * Reaction path, fastest first:
 *  1. A CurveBuy / CurveSell log on a position's curve -> apply the reserve delta
 *     from the event itself (no RPC) and evaluate that instant. This is the path
 *     a dump-through-your-stop takes.
 *  2. Every new block -> multicall-price all positions and evaluate.
 *  3. Heartbeat timer -> safety-net full sweep.
 *
 * Absolute speed is gated by how fast the RPC delivers the log/block:
 *   - public HTTP endpoint: state lags ~1-3s, and we poll on top of that
 *   - private HTTP endpoint: ~1 block, plus the polling interval
 *   - WSS_URL set: blocks and logs are PUSHED via eth_subscribe, so the polling
 *     interval leaves the critical path entirely
 * `rpcLagMs` and `transport` in the status reflect what you're actually getting.
 */

interface Cached extends CurveReserves {
  at: number;
  /**
   * The curve's immutable phantom (virtual) quote reserve, derived at sync time
   * as `getReserves().quote - realQuoteReserve()`. Lets the event fast path
   * recover real progress toward graduation without another RPC call:
   * realQuote = quoteReserve - phantom.
   */
  phantom: bigint | null;
}
interface MonitorState {
  running: boolean;
  heartbeat: ReturnType<typeof setTimeout> | undefined;
  unwatchBlocks: (() => void) | undefined;
  curveWatchers: Map<string, () => void>; // positionId -> unwatch
  priceCache: Map<string, Cached>; // positionId -> last known reserves
  evalTimer: ReturnType<typeof setTimeout> | undefined;
  evaluating: boolean;
  rerun: boolean;
  passes: number;
  fastExits: number;
  lastPassAt: string | null;
  lastReason: string | null;
  lastError: string | null;
  lastBlock: bigint;
  lastBlockAt: number;
  lagSamples: number[];
}

const g = globalThis as typeof globalThis & { __ponsMonitor?: MonitorState };
const s: MonitorState =
  g.__ponsMonitor ??
  (g.__ponsMonitor = {
    running: false,
    heartbeat: undefined,
    unwatchBlocks: undefined,
    curveWatchers: new Map(),
    priceCache: new Map(),
    evalTimer: undefined,
    evaluating: false,
    rerun: false,
    passes: 0,
    fastExits: 0,
    lastPassAt: null,
    lastReason: null,
    lastError: null,
    lastBlock: 0n,
    lastBlockAt: 0,
    lagSamples: [],
  });

const EVAL_DEBOUNCE_MS = 120;
/** Don't apply event deltas on top of a baseline older than this. */
const CACHE_MAX_AGE_MS = 30_000;
/** A position stuck in `closing` longer than this is re-opened for retry. */
const STUCK_CLOSING_MS = 180_000;
/** How often a dry-run exit may re-announce itself for the same position. */
const DRY_RUN_REPEAT_MS = 60_000;

function noteBlock(bn: bigint): void {
  if (bn === s.lastBlock) return;
  const now = Date.now();
  if (s.lastBlockAt) {
    s.lagSamples.push(now - s.lastBlockAt);
    if (s.lagSamples.length > 20) s.lagSamples.shift();
  }
  s.lastBlock = bn;
  s.lastBlockAt = now;
}

function priceOf(row: PositionRow, r: CurveReserves): number {
  return priceFromReserves(r, row.token_decimals, row.quote_decimals).priceQuote;
}

/**
 * Apply a CurveBuy / CurveSell to cached reserves using only the event's own
 * numbers — exact per PonsV2BondingCurve.buy/sell + getReserves().
 *   sell: quoteReserve -= (quoteOut + fee + tax); tokenReserve += tokensIn
 *   buy : quoteReserve += (quoteIn - fee - tax);  tokenReserve -= tokensOut
 */
export function applyEventDelta(
  r: CurveReserves,
  name: string,
  a: Record<string, bigint>,
): CurveReserves {
  if (name === "CurveSell") {
    const gross = (a.quoteOut ?? 0n) + (a.fee ?? 0n) + (a.tax ?? 0n);
    return {
      quoteReserve: r.quoteReserve > gross ? r.quoteReserve - gross : 0n,
      tokenReserve: r.tokenReserve + (a.tokensIn ?? 0n),
    };
  }
  if (name === "CurveBuy") {
    const net = (a.quoteIn ?? 0n) - (a.fee ?? 0n) - (a.tax ?? 0n);
    return {
      quoteReserve: r.quoteReserve + (net > 0n ? net : 0n),
      tokenReserve: r.tokenReserve > (a.tokensOut ?? 0n) ? r.tokenReserve - (a.tokensOut ?? 0n) : 0n,
    };
  }
  return r;
}

/**
 * Fire a sell without blocking the caller.
 *
 * The pass must not await this: `waitForTransactionReceipt` can take seconds,
 * and awaiting it inside the evaluation loop would freeze every OTHER
 * position's stop-loss until this one settles. `claimForClosing` has already
 * been taken by the caller, so there is no double-sell risk.
 */
function dispatchClose(id: string, reason: CloseReason, symbol: string): void {
  void closePosition(id, reason, { alreadyClaimed: true }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    logEngine("error", `close dispatch threw for ${symbol}: ${msg}`, id);
    // Never leave it stranded in `closing` — runPass only looks at `open`.
    try {
      updatePosition(id, { status: "open", error: `close dispatch threw: ${msg}` });
    } catch {
      /* nothing more we can do */
    }
  });
}

/**
 * Shared: persist the price, and sell if a rule trips.
 * Re-reads the row so a concurrent writer's newer peak_price is not clobbered
 * by a stale snapshot (which would loosen a trailing stop).
 */
function evaluateRow(
  rowIn: PositionRow,
  input: ExitInputs,
  via: string,
  graduated = false,
  ready = false,
): void {
  const row = getPosition(rowIn.id) ?? rowIn;
  if (row.status !== "open") return;

  const decision = evaluateExit(row, input);
  updatePosition(row.id, {
    last_price: input.price,
    peak_price: decision.peakPrice,
    last_checked_at: new Date().toISOString(),
  });

  if (graduated || ready) {
    if (claimForClosing(row.id)) {
      updatePosition(row.id, {
        status: "failed",
        close_reason: "error",
        error:
          "token graduated to a Uniswap v4 pool — sell manually on pons.family (v4 selling not yet supported)",
      });
      logEngine("error", `${row.token_symbol} graduated — manual action needed`, row.id);
    }
    return;
  }

  if (!decision.shouldExit || !decision.reason) return;

  // In dry-run the trigger stays true forever (nothing is sold), so without a
  // throttle the same exit re-fires on every pass and floods the log.
  if (!isLive()) {
    const last = row.last_dry_run_at ? Date.parse(row.last_dry_run_at) : 0;
    if (Number.isFinite(last) && Date.now() - last < DRY_RUN_REPEAT_MS) return;
  }

  if (!claimForClosing(row.id)) return;
  if (via.startsWith("trade-log")) s.fastExits += 1;
  logEngine("info", `exit trigger (${decision.reason}, via ${via}): ${decision.detail}`, row.id);
  dispatchClose(row.id, decision.reason, row.token_symbol);
}

function scheduleEval(reason: string): void {
  s.lastReason = reason;
  if (s.evaluating) {
    s.rerun = true;
    return;
  }
  if (s.evalTimer) return;
  s.evalTimer = setTimeout(() => {
    s.evalTimer = undefined;
    void runPass();
  }, EVAL_DEBOUNCE_MS);
  if (s.evalTimer && typeof s.evalTimer === "object" && "unref" in s.evalTimer) {
    s.evalTimer.unref();
  }
}

/**
 * The fast path: a trade on a curve we hold — react from the log alone.
 *
 * Positions are looked up by CURVE at call time, not captured in the watcher
 * closure: a second position opened later on the same curve must also get the
 * fast path, and a closure would still hold the original id list.
 */
function onCurveLogs(curveKey: string, logs: Log[]): void {
  try {
    const rows = listOpenPositions().filter(
      (r) => r.status === "open" && r.curve_address.toLowerCase() === curveKey,
    );
    if (rows.length === 0) return;

    for (const raw of logs) {
      const l = raw as Log & { eventName?: string; args?: Record<string, bigint> };
      if (!l.eventName || (l.eventName !== "CurveBuy" && l.eventName !== "CurveSell")) continue;
      for (const row of rows) {
        const cached = s.priceCache.get(row.id);
        // Only trust the incremental delta against a recently synced baseline;
        // other curve activity (fee sweeps, buybacks) also moves getReserves().
        if (!cached || Date.now() - cached.at > CACHE_MAX_AGE_MS) continue;
        const next = applyEventDelta(cached, l.eventName, l.args ?? {});
        s.priceCache.set(row.id, { ...next, at: Date.now(), phantom: cached.phantom });
        // A buy is exactly what pushes a curve over the graduation threshold,
        // so the fast path must be able to see progress too.
        const gradPct =
          cached.phantom != null
            ? graduationProgressPct(
                next.quoteReserve > cached.phantom ? next.quoteReserve - cached.phantom : 0n,
                row.graduation_threshold_wei,
              )
            : undefined;
        evaluateRow(
          row,
          { price: priceOf(row, next), graduationPct: gradPct },
          `trade-log:${l.eventName}`,
        );
      }
    }
  } catch (err) {
    // Must never throw out of a watcher callback — an unhandled rejection or
    // sync throw here would take the whole server down.
    s.lastError = err instanceof Error ? err.message : String(err);
    logEngine("error", `curve log handler failed: ${s.lastError}`);
  } finally {
    scheduleEval("trade-log"); // authoritative refresh right after
  }
}

/** Add/remove per-curve event watchers to match the current open positions. */
function reconcileWatchers(open: PositionRow[]): void {
  // One watcher per curve, however many positions sit on it.
  const byCurve = new Set(open.map((r) => r.curve_address.toLowerCase()));

  for (const [key, unwatch] of s.curveWatchers) {
    if (!byCurve.has(key)) {
      try {
        unwatch();
      } catch {
        /* ignore */
      }
      s.curveWatchers.delete(key);
    }
  }

  for (const key of byCurve) {
    if (s.curveWatchers.has(key)) continue;
    let addr: Address;
    try {
      addr = getAddress(key);
    } catch {
      continue;
    }
    try {
      const unwatch = publicClient().watchContractEvent({
        address: addr,
        abi: bondingCurveAbi,
        // `poll` omitted on purpose: viem polls on HTTP and uses
        // eth_subscribe on a WebSocket automatically.
        pollingInterval: env.pollingIntervalMs,
        // Pass the curve, not a position-id list — see onCurveLogs.
        onLogs: (logs) => onCurveLogs(key, logs as Log[]),
        onError: () => {},
      });
      s.curveWatchers.set(key, unwatch);
    } catch {
      /* a bad curve address shouldn't kill the loop */
    }
  }
}

/**
 * Re-open positions left in `closing` — a crash mid-sell, or a dispatch that
 * never resolved, would otherwise strand them: runPass only looks at `open`,
 * so nothing would ever retry the exit.
 */
function reapStuckClosing(): void {
  const now = Date.now();
  for (const r of listOpenPositions()) {
    if (r.status !== "closing") continue;
    const age = now - Date.parse(r.updated_at);
    if (Number.isFinite(age) && age > STUCK_CLOSING_MS) {
      updatePosition(r.id, {
        status: "open",
        error: "sell did not complete — re-armed for retry",
      });
      logEngine("warn", `re-armed ${r.token_symbol} after a stuck close`, r.id);
    }
  }
}

async function runPass(): Promise<void> {
  if (!s.running) return;
  s.evaluating = true;
  try {
    reapStuckClosing();
    const open = listOpenPositions().filter((r) => r.status === "open");
    reconcileWatchers(open);
    s.passes += 1;
    s.lastPassAt = new Date().toISOString();
    if (open.length === 0) {
      s.priceCache.clear();
      s.lastError = null;
      return;
    }

    const PER_POSITION = 4;
    const contracts = open.flatMap((r) => {
      const address = getAddress(r.curve_address);
      return [
        { address, abi: bondingCurveAbi, functionName: "getReserves" as const },
        { address, abi: bondingCurveAbi, functionName: "graduated" as const },
        { address, abi: bondingCurveAbi, functionName: "readyToGraduate" as const },
        { address, abi: bondingCurveAbi, functionName: "realQuoteReserve" as const },
      ];
    });
    const results = await readClient().multicall({ contracts, allowFailure: true });

    for (let i = 0; i < open.length; i++) {
      const row = open[i];
      const base = i * PER_POSITION;
      const rRes = results[base];
      const gRes = results[base + 1];
      const yRes = results[base + 2];
      const qRes = results[base + 3];
      if (rRes.status !== "success") continue;

      const [quoteReserve, tokenReserve] = rRes.result as readonly [bigint, bigint];
      const realQuote = qRes.status === "success" ? (qRes.result as bigint) : null;
      s.priceCache.set(row.id, {
        quoteReserve,
        tokenReserve,
        at: Date.now(),
        phantom: realQuote != null ? quoteReserve - realQuote : null,
      });

      const gradPct =
        realQuote != null
          ? graduationProgressPct(realQuote, row.graduation_threshold_wei)
          : undefined;

      // Not awaited internally: evaluateRow dispatches sells without blocking,
      // so a slow receipt on one position can't stall the others' stop-losses.
      evaluateRow(
        row,
        { price: priceOf(row, { quoteReserve, tokenReserve }), graduationPct: gradPct },
        "block",
        gRes.status === "success" && gRes.result === true,
        yRes.status === "success" && yRes.result === true,
      );
    }

    s.lastError = null;
  } catch (err) {
    s.lastError = err instanceof Error ? err.message : String(err);
    logEngine("error", `monitor pass failed: ${s.lastError}`);
  } finally {
    s.evaluating = false;
    if (s.passes % 300 === 0) pruneEngineLog();
    if (s.rerun) {
      s.rerun = false;
      scheduleEval(s.lastReason ?? "rerun");
    }
  }
}

export function startMonitor(): void {
  if (s.running) return;
  s.running = true;

  try {
    s.unwatchBlocks = publicClient().watchBlockNumber({
      emitOnBegin: true,
      pollingInterval: env.pollingIntervalMs,
      onBlockNumber: (bn) => {
        noteBlock(bn);
        scheduleEval("block");
      },
      onError: () => {},
    });
  } catch (err) {
    logEngine("warn", `watchBlockNumber failed, heartbeat only: ${String(err)}`);
  }

  const beat = () => {
    if (!s.running) return;
    scheduleEval("heartbeat");
    s.heartbeat = setTimeout(beat, env.monitorHeartbeatMs);
    if (s.heartbeat && typeof s.heartbeat === "object" && "unref" in s.heartbeat) {
      s.heartbeat.unref();
    }
  };
  beat();

  logEngine(
    "info",
    `monitor started (${isLive() ? "LIVE" : "DRY-RUN"}, event-driven, ` +
      `poll ${env.pollingIntervalMs}ms / heartbeat ${env.monitorHeartbeatMs}ms)` +
      (hasBotWallet() ? "" : " — no bot wallet yet"),
  );
  scheduleEval("start");
}

export function stopMonitor(): void {
  s.running = false;
  if (s.heartbeat) clearTimeout(s.heartbeat);
  if (s.evalTimer) clearTimeout(s.evalTimer);
  s.unwatchBlocks?.();
  s.unwatchBlocks = undefined;
  for (const unwatch of s.curveWatchers.values()) {
    try {
      unwatch();
    } catch {
      /* ignore */
    }
  }
  s.curveWatchers.clear();
  s.priceCache.clear();
}

/** Force an immediate re-check (call right after opening a position). */
export function kickMonitor(): void {
  scheduleEval("kick");
}

export function monitorStatus() {
  const lagMs = s.lagSamples.length
    ? Math.round(s.lagSamples.reduce((a, b) => a + b, 0) / s.lagSamples.length)
    : null;
  return {
    running: s.running,
    live: isLive(),
    mode: "event" as const,
    transport: isWebSocket() ? ("websocket" as const) : ("http" as const),
    pollingMs: env.pollingIntervalMs,
    heartbeatMs: env.monitorHeartbeatMs,
    watching: s.curveWatchers.size,
    passes: s.passes,
    fastExits: s.fastExits,
    lastPassAt: s.lastPassAt,
    lastReason: s.lastReason,
    lastError: s.lastError,
    rpcLagMs: lagMs,
    rpcSlow: lagMs != null && lagMs > 1500,
    hasWallet: hasBotWallet(),
    ticks: s.passes,
  };
}
