import { getAddress, parseEther, type Address, type Log } from "viem";
import { publicClient, isWebSocket } from "../chain";
import { env } from "../env";
import { db, logEngine } from "../db/index";
import { PONS } from "../pons/addresses";
import { ponsFactoryAbi, bondingCurveAbi } from "../pons/abis";
import { getTokenSnapshot } from "../pons/tokens";
import { buyOnCurve } from "../pons/swap";
import { createPosition, countOpenBySource } from "../db/positions";
import { getBotBalance, hasBotWallet } from "../wallet/botWallet";
import { isLive } from "../engine/liveState";
import { kickMonitor } from "../engine/monitor";
import { loadSniperConfig } from "./config";
import { evaluateLaunch, type LaunchInfo } from "./filters";

interface SniperState {
  running: boolean;
  unwatch: (() => void) | undefined;
  seen: Set<string>;
  pending: Map<string, ReturnType<typeof setTimeout>>;
  /** Serialises evaluations so concurrent launches can't bypass the caps. */
  queue: Promise<void>;
  /** Buys that have passed the caps but whose rows aren't written yet. */
  inFlightCount: number;
  inFlightEth: number;
  launchesSeen: number;
  evaluated: number;
  sniped: number;
  skipped: number;
  errors: number;
  lastError: string | null;
  startedAt: number;
}

// globalThis-backed so instrumentation (boot) and the API routes share one
// watcher + counters — Next runs them in separate module registries.
const g = globalThis as typeof globalThis & { __ponsSniper?: SniperState };
const s: SniperState =
  g.__ponsSniper ??
  (g.__ponsSniper = {
    running: false,
    unwatch: undefined,
    seen: new Set(),
    pending: new Map(),
    queue: Promise.resolve(),
    inFlightCount: 0,
    inFlightEth: 0,
    launchesSeen: 0,
    evaluated: 0,
    sniped: 0,
    skipped: 0,
    errors: 0,
    lastError: null,
    startedAt: 0,
  });

type Decision = "bought" | "skipped" | "error";

function record(
  decision: Decision,
  reason: string,
  info: {
    token: string;
    symbol?: string;
    deployer?: string;
    ethAmount?: string;
    buyTx?: string;
    positionId?: string;
  },
): void {
  try {
    db()
      .prepare(
        `INSERT INTO sniper_events (ts, token_address, token_symbol, deployer, decision, reason, eth_amount, buy_tx, position_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        new Date().toISOString(),
        info.token.toLowerCase(),
        info.symbol ?? null,
        info.deployer?.toLowerCase() ?? null,
        decision,
        reason,
        info.ethAmount ?? null,
        info.buyTx ?? null,
        info.positionId ?? null,
      );
  } catch {
    /* never throw from the sniper hot path */
  }
  if (decision === "bought") s.sniped += 1;
  else if (decision === "skipped") s.skipped += 1;
  else s.errors += 1;
  logEngine(
    decision === "error" ? "error" : "info",
    `sniper ${decision} ${info.symbol ?? info.token.slice(0, 10)}: ${reason}`,
  );
}

/** ETH spent by the sniper since local midnight. */
function spentTodayEth(): number {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const rows = db()
    .prepare(
      `SELECT eth_amount FROM sniper_events WHERE decision = 'bought' AND ts >= ?`,
    )
    .all(since.toISOString()) as { eth_amount: string | null }[];
  return rows.reduce((sum, r) => sum + (r.eth_amount ? Number(r.eth_amount) : 0), 0);
}

function snipesLastHour(): number {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const r = db()
    .prepare(`SELECT COUNT(*) AS n FROM sniper_events WHERE decision = 'bought' AND ts >= ?`)
    .get(since) as { n: number };
  return r?.n ?? 0;
}

/** Count buys on the curve since `fromBlock` by wallets other than the deployer. */
async function countOtherBuys(curve: Address, deployer: Address, fromBlock: bigint): Promise<number> {
  try {
    const logs = await publicClient().getContractEvents({
      address: curve,
      abi: bondingCurveAbi,
      eventName: "CurveBuy",
      fromBlock,
      toBlock: "latest",
    });
    const dep = deployer.toLowerCase();
    const buyers = new Set<string>();
    for (const l of logs) {
      const buyer = (l.args as { buyer?: string }).buyer?.toLowerCase();
      if (buyer && buyer !== dep) buyers.add(buyer);
    }
    return buyers.size;
  } catch {
    return 0;
  }
}

async function evaluate(launch: LaunchInfo, launchBlock: bigint): Promise<void> {
  s.pending.delete(launch.token.toLowerCase());
  s.evaluated += 1;
  const cfg = loadSniperConfig();

  if (!cfg.enabled) {
    record("skipped", "sniper disabled before buy", { token: launch.token, deployer: launch.deployer });
    return;
  }
  if (!hasBotWallet()) {
    record("skipped", "no bot wallet", { token: launch.token, deployer: launch.deployer });
    return;
  }

  try {
    // Safety caps. `inFlight*` counts buys that have passed these checks but
    // whose rows aren't written yet — without it, launches evaluated back to
    // back would each see a stale zero and blow straight through every cap.
    if (countOpenBySource("sniper") + s.inFlightCount >= cfg.maxConcurrentSnipes) {
      record("skipped", `at max concurrent snipes (${cfg.maxConcurrentSnipes})`, {
        token: launch.token,
        deployer: launch.deployer,
      });
      return;
    }
    if (snipesLastHour() + s.inFlightCount >= cfg.maxSnipesPerHour) {
      record("skipped", `hourly snipe cap (${cfg.maxSnipesPerHour})`, {
        token: launch.token,
        deployer: launch.deployer,
      });
      return;
    }
    const ethAmount = cfg.ethAmount;
    if (spentTodayEth() + s.inFlightEth + Number(ethAmount) > cfg.maxDailySpendEth) {
      record("skipped", `daily spend cap (${cfg.maxDailySpendEth} ETH)`, {
        token: launch.token,
        deployer: launch.deployer,
      });
      return;
    }

    const snapshot = await getTokenSnapshot(launch.token);
    // Only pay for the CurveBuy log scan if the filter actually needs it.
    const otherBuys =
      cfg.minOtherBuys > 0
        ? await countOtherBuys(getAddress(launch.curve), getAddress(launch.deployer), launchBlock)
        : 0;
    const liquidityEth = snapshot.graduation.currentQuote;

    const verdict = evaluateLaunch({ launch, snapshot, liquidityEth, otherBuys }, cfg);
    if (!verdict.buy) {
      record("skipped", verdict.reason, {
        token: launch.token,
        symbol: snapshot.symbol,
        deployer: launch.deployer,
      });
      return;
    }

    if (!isLive()) {
      record("skipped", `DRY-RUN: would snipe (${verdict.reason})`, {
        token: launch.token,
        symbol: snapshot.symbol,
        deployer: launch.deployer,
        ethAmount,
      });
      return;
    }

    const ethWei = parseEther(ethAmount);
    const bal = await getBotBalance();
    if (bal.ethWei < ethWei + parseEther("0.0005")) {
      record("skipped", `insufficient balance (${bal.eth} ETH)`, {
        token: launch.token,
        symbol: snapshot.symbol,
        deployer: launch.deployer,
      });
      return;
    }

    // Reserve against the caps for the whole duration of the buy.
    s.inFlightCount += 1;
    s.inFlightEth += Number(ethAmount);
    let buy;
    try {
      buy = await buyOnCurve({
        curve: getAddress(snapshot.curve!),
        token: getAddress(launch.token),
        pairToken: snapshot.pairToken,
        tokenDecimals: snapshot.decimals,
        quoteDecimals: snapshot.quoteDecimals,
        feeBps: snapshot.feeBps,
        creatorTaxBps: snapshot.creatorTaxBps,
        reserves: snapshot.reserves,
        slippageBps: cfg.slippageBps,
        quoteInWei: ethWei,
      });
    } finally {
      s.inFlightCount -= 1;
      s.inFlightEth -= Number(ethAmount);
    }

    if (buy.filled <= 0n) {
      record("error", "buy returned 0 tokens", {
        token: launch.token,
        symbol: snapshot.symbol,
        deployer: launch.deployer,
        ethAmount,
      });
      return;
    }

    // The buy is already on-chain. If we fail to record the position the tokens
    // become an invisible, unmanaged bag with no stop-loss — so this gets its
    // own handler that screams loudly enough to recover by hand.
    let positionId: string | undefined;
    try {
      positionId = createPosition({
        tokenAddress: getAddress(launch.token),
        tokenSymbol: snapshot.symbol,
        tokenDecimals: snapshot.decimals,
        curveAddress: getAddress(snapshot.curve!),
        pairToken: snapshot.pairToken,
        quoteSymbol: snapshot.quoteSymbol,
        quoteDecimals: snapshot.quoteDecimals,
        feeBps: snapshot.feeBps,
        creatorTaxBps: snapshot.creatorTaxBps,
        quoteInWei: ethWei,
        tokensHeldWei: buy.filled,
        entryPrice: buy.effectivePrice || snapshot.price.priceQuote,
        buyTx: buy.hash,
        source: "sniper",
        takeProfitPct: cfg.takeProfitPct,
        stopLossPct: cfg.stopLossPct,
        trailingStopPct: cfg.trailingStopPct,
        graduationExitPct: cfg.graduationExitPct,
        graduationThresholdWei: snapshot.graduation.thresholdWei,
        slippageBps: cfg.slippageBps,
      }).id;
    } catch (persistErr) {
      const pmsg = persistErr instanceof Error ? persistErr.message : String(persistErr);
      record(
        "error",
        `BOUGHT BUT NOT TRACKED — ${buy.filled} units of ${launch.token} held with NO stop-loss. ` +
          `tx ${buy.hash}. Sell manually. Cause: ${pmsg}`,
        {
          token: launch.token,
          symbol: snapshot.symbol,
          deployer: launch.deployer,
          ethAmount,
          buyTx: buy.hash,
        },
      );
      return;
    }

    kickMonitor();
    record("bought", `sniped for ${ethAmount} ETH, tx ${buy.hash}`, {
      token: launch.token,
      symbol: snapshot.symbol,
      deployer: launch.deployer,
      ethAmount,
      buyTx: buy.hash,
      positionId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    s.lastError = msg;
    record("error", msg, { token: launch.token, deployer: launch.deployer });
  }
}

/**
 * Run evaluations strictly one at a time.
 *
 * Launches arrive in bursts (9 within one second, observed), and each gets its
 * own timer. Running them concurrently meant every evaluation read the caps
 * before any of them had written a position row or a 'bought' event, so
 * maxConcurrentSnipes / maxSnipesPerHour / maxDailySpendEth were all evaluated
 * against a stale zero and every launch in the burst bought.
 */
function enqueue(launch: LaunchInfo, blockNumber: bigint): void {
  s.queue = s.queue
    .then(() => evaluate(launch, blockNumber))
    .catch((err) => {
      // A queue link must never reject, or every later launch is dropped.
      s.lastError = err instanceof Error ? err.message : String(err);
      logEngine("error", `sniper evaluation threw: ${s.lastError}`);
    });
}

function onLaunchLogs(logs: Log[]): void {
  try {
    handleLaunchLogs(logs);
  } catch (err) {
    // Watcher callbacks must never throw — it would take the server down.
    s.lastError = err instanceof Error ? err.message : String(err);
    logEngine("error", `sniper log handler failed: ${s.lastError}`);
  }
}

function handleLaunchLogs(logs: Log[]): void {
  const cfg = loadSniperConfig();
  for (const raw of logs) {
    const l = raw as Log & { eventName?: string; args?: Record<string, unknown>; blockNumber: bigint };
    if (l.eventName !== "TokenLaunched" || !l.args) continue;
    const token = String(l.args.token ?? "");
    if (!token) continue;
    const key = token.toLowerCase();
    if (s.seen.has(key)) continue;
    s.seen.add(key);
    s.launchesSeen += 1;
    if (s.seen.size > 5000) s.seen = new Set([...s.seen].slice(-2500));

    const launch: LaunchInfo = {
      token,
      curve: String(l.args.curve ?? ""),
      deployer: String(l.args.deployer ?? ""),
      pairToken: String(l.args.pairToken ?? ""),
      graduationThreshold: (l.args.graduationThreshold as bigint) ?? 0n,
    };
    if (!cfg.enabled) {
      record("skipped", "sniper disabled", { token, deployer: launch.deployer });
      continue;
    }
    const delayMs = Math.max(0, cfg.delaySeconds) * 1000;
    const timer = setTimeout(() => enqueue(launch, l.blockNumber), delayMs);
    if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
    s.pending.set(key, timer);
  }
}

export function startSniper(): void {
  if (s.running) return;
  s.running = true;
  s.startedAt = Date.now();
  try {
    s.unwatch = publicClient().watchContractEvent({
      address: PONS.factory,
      abi: ponsFactoryAbi,
      eventName: "TokenLaunched",
      // Pushed via eth_subscribe when WSS_URL is set; polled on HTTP.
      pollingInterval: env.pollingIntervalMs,
      onLogs: (logs) => onLaunchLogs(logs as Log[]),
      onError: () => {},
    });
    logEngine("info", `sniper watcher started (factory ${PONS.factory})`);
  } catch (err) {
    s.running = false;
    logEngine("error", `sniper failed to start: ${String(err)}`);
  }
}

export function stopSniper(): void {
  s.running = false;
  s.unwatch?.();
  s.unwatch = undefined;
  for (const t of s.pending.values()) clearTimeout(t);
  s.pending.clear();
}

export function sniperStatus() {
  const cfg = loadSniperConfig();
  const recent = db()
    .prepare(
      `SELECT ts, token_address, token_symbol, deployer, decision, reason, eth_amount, buy_tx, position_id
       FROM sniper_events ORDER BY id DESC LIMIT 40`,
    )
    .all();
  return {
    running: s.running,
    enabled: cfg.enabled,
    live: isLive(),
    watching: !!s.unwatch,
    pending: s.pending.size,
    launchesSeen: s.launchesSeen,
    evaluated: s.evaluated,
    sniped: s.sniped,
    skipped: s.skipped,
    errors: s.errors,
    spentTodayEth: spentTodayEth(),
    snipesLastHour: snipesLastHour(),
    openSnipes: countOpenBySource("sniper"),
    lastError: s.lastError,
    recent,
  };
}
