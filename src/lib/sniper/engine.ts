import { getAddress, parseEther, type Address, type Log } from "viem";
import {
  demoteWebSocket,
  isWebSocket,
  publicClient,
  readClient,
  redactRpc,
  webSocketDemotedReason,
} from "../chain";
import { env } from "../env";
import { db, logEngine } from "../db/index";
import { PONS } from "../pons/addresses";
import { ponsFactoryAbi, bondingCurveAbi } from "../pons/abis";
import { getTokenSnapshot } from "../pons/tokens";
import { buyOnCurve } from "../pons/swap";
import { quoteAmountInEth, zapEthToQuote } from "../pons/zap";
import { createPosition, countOpenBySource } from "../db/positions";
import { getBotBalance, hasBotWallet } from "../wallet/botWallet";
import { isLive } from "../engine/liveState";
import { kickMonitor } from "../engine/monitor";
import { loadSniperConfig, saveSniperConfig, type SniperConfig } from "./config";
import { evaluateLaunch, type LaunchInfo, type TickerHit } from "./filters";
import { erc20Abi } from "../pons/abis";

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
  /** Highest block the reconciliation sweep has accounted for. */
  lastReconciledBlock: bigint;
  /** Launches the sweep found that the live subscription never delivered. */
  missed: number;
  reconcile: ReturnType<typeof setInterval> | undefined;
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
    lastReconciledBlock: 0n,
    missed: 0,
    reconcile: undefined,
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
    quoteSymbol?: string;
    liquidity?: number;
    otherBuys?: number;
    gradPct?: number;
    blockedByQuote?: boolean;
    logo?: string;
  },
): void {
  try {
    db()
      .prepare(
        `INSERT INTO sniper_events
           (ts, token_address, token_symbol, deployer, decision, reason, eth_amount, buy_tx, position_id,
            quote_symbol, liquidity, other_buys, grad_pct, blocked_by_quote, logo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        info.quoteSymbol ?? null,
        info.liquidity ?? null,
        info.otherBuys ?? null,
        info.gradPct ?? null,
        info.blockedByQuote ? 1 : 0,
        info.logo ?? null,
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

/**
 * Wallets other than the deployer that have bought since `fromBlock`.
 *
 * Returns the addresses, not just a count: the proven-buyer filter cares WHICH
 * wallets bought, since a curve backed by people who have been early on a
 * graduate before is the only signal that beat its control in testing.
 */
async function otherBuyers(curve: Address, deployer: Address, fromBlock: bigint): Promise<string[]> {
  try {
    const logs = await readClient().getContractEvents({
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
    return [...buyers];
  } catch {
    return [];
  }
}

async function evaluate(
  launch: LaunchInfo,
  launchBlock: bigint,
  hit: TickerHit | null = null,
): Promise<void> {
  s.pending.delete(launch.token.toLowerCase());
  s.evaluated += 1;
  const cfg = loadSniperConfig();

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
    // A watch may set its own size; otherwise the global amount applies. The
    // spend caps below are checked against whichever it is.
    const ethAmount = hit?.ethAmount?.trim() || cfg.ethAmount;
    if (spentTodayEth() + s.inFlightEth + Number(ethAmount) > cfg.maxDailySpendEth) {
      record("skipped", `daily spend cap (${cfg.maxDailySpendEth} ETH)`, {
        token: launch.token,
        deployer: launch.deployer,
      });
      return;
    }

    const snapshot = await getTokenSnapshot(launch.token);
    const buyers = await otherBuyers(getAddress(launch.curve), getAddress(launch.deployer), launchBlock);
    const otherBuys = buyers.length;
    /*
     * The liquidity band is written in ETH, so the curve's reserve has to be
     * expressed in ETH before it is compared to one.
     *
     * For a native curve those are the same number. For a USDG or NVDA curve
     * they are not, and reading the raw reserve as if it were ETH compared 100
     * USDG against a 0.05 ETH floor and let it through — a bug that could not
     * happen until non-ETH launches became buyable, and appears the moment
     * they do. Priced through the same pool the zap would use, so the filter
     * judges what a real swap would fetch.
     */
    let liquidityEth = snapshot.graduation.currentQuote;
    if (!snapshot.quoteIsNative && cfg.allowNonEthQuotes) {
      const raw = snapshot.reserves?.quoteReserve ?? 0n;
      const inEth = await quoteAmountInEth(getAddress(snapshot.pairToken), raw);
      // No route means we could not buy it anyway; leave it at zero so the
      // liquidity floor rejects it rather than guessing.
      liquidityEth = inEth == null ? 0 : Number(inEth) / 1e18;
    }
    /** Everything the launch feed shows, recorded on every decision alike. */
    const seen = {
      token: launch.token,
      symbol: snapshot.symbol,
      deployer: launch.deployer,
      quoteSymbol: snapshot.quoteSymbol,
      liquidity: liquidityEth,
      otherBuys,
      gradPct: snapshot.graduation.progressPct,
      logo: snapshot.logo,
    };

    const verdict = evaluateLaunch(
      { launch, snapshot, liquidityEth, otherBuys, buyers, tickerHit: hit },
      cfg,
    );
    if (!verdict.buy) {
      record("skipped", verdict.reason, { ...seen, blockedByQuote: verdict.blockedByQuote });
      return;
    }

    // It passed. Everything from here is about whether we may actually spend.
    if (!cfg.enabled) {
      record("skipped", `DRY-RUN: would snipe (sniper off — ${verdict.reason})`, { ...seen, ethAmount });
      return;
    }
    if (!hasBotWallet()) {
      record("skipped", `DRY-RUN: would snipe (no bot wallet)`, { ...seen, ethAmount });
      return;
    }

    if (!isLive()) {
      record("skipped", `DRY-RUN: would snipe (${verdict.reason})`, {
        ...seen,
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
    /*
     * A curve that does not take ETH needs its quote asset bought first.
     *
     * Sized from what the swap actually delivered rather than from the quote,
     * and recorded as the cost basis below for the same reason: the executor
     * computes realised PnL in quote units, so an ETH figure against a 6-decimal
     * stablecoin would be out by a factor of 1e12.
     */
    let curveInWei = ethWei;
    let zapTx: string | null = null;
    try {
      if (!snapshot.quoteIsNative) {
        const zapped = await zapEthToQuote(
          getAddress(snapshot.pairToken),
          ethWei,
          cfg.slippageBps,
        );
        curveInWei = zapped.received;
        zapTx = zapped.hash;
      }
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
        quoteInWei: curveInWei,
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

    /*
     * Spend it, count it. Credited here rather than after the position row is
     * written, because the money has already left: the recovery path below
     * handles a buy that could not be recorded, and re-arming the watch there
     * would let one ticker be bought twice off a single maxBuys of 1.
     */
    if (hit) creditWatch(hit.ticker);

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
        quoteInWei: curveInWei,
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
    record("bought", `sniped for ${ethAmount} ETH${zapTx ? ` via ${snapshot.quoteSymbol}` : ""}, tx ${buy.hash}`, {
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
/** Watches that are still armed: under their buy limit and not expired. */
function activeWatches(cfg: SniperConfig): SniperConfig["tickerWatch"] {
  const now = Date.now();
  return cfg.tickerWatch.filter(
    (w) => w.bought < w.maxBuys && (!w.expiresAt || Date.parse(w.expiresAt) > now),
  );
}

/**
 * The symbol, read straight from the token.
 *
 * TokenLaunched does not carry it, and the whole point of a ticker watch is to
 * decide BEFORE the observation window elapses, so this cannot wait for the
 * feed indexer to catch up. One eth_call, and only when a watch is armed —
 * with none configured this costs nothing at ~24k launches a day.
 */
async function symbolOf(token: string): Promise<string | null> {
  try {
    return String(
      await readClient().readContract({
        address: getAddress(token),
        abi: erc20Abi,
        functionName: "symbol",
      }),
    );
  } catch {
    return null;
  }
}

/** Record a completed ticker buy so the watch disarms itself. */
function creditWatch(ticker: string): void {
  const cfg = loadSniperConfig();
  const key = ticker.trim().toLowerCase();
  let touched = false;
  for (const w of cfg.tickerWatch) {
    if (w.ticker.trim().toLowerCase() === key && w.bought < w.maxBuys) {
      w.bought += 1;
      touched = true;
      break;
    }
  }
  if (touched) saveSniperConfig(cfg);
}

function enqueue(launch: LaunchInfo, blockNumber: bigint, hit: TickerHit | null = null): void {
  s.queue = s.queue
    .then(() => evaluate(launch, blockNumber, hit))
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
    // A disabled sniper still watches and still evaluates, so it can SUGGEST
    // launches that pass the filters without buying them. Buying is gated in
    // evaluate(); everything before that is just looking.
    //
    // `watchWhenDisabled` exists because looking is not free — pricing and
    // filtering every launch is two RPC calls each at ~24k launches a day, and
    // someone on a metered endpoint should be able to turn it off.
    if (!cfg.enabled && !cfg.watchWhenDisabled) {
      continue;
    }

    const watches = activeWatches(cfg);
    if (!watches.length) {
      const delayMs = Math.max(0, cfg.delaySeconds) * 1000;
      const timer = setTimeout(() => enqueue(launch, l.blockNumber), delayMs);
      if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
      s.pending.set(key, timer);
      continue;
    }

    /*
     * With a watch armed, the symbol has to be read before the delay is
     * chosen — a ticker match uses the fast one, and by the time the normal
     * 20-second window has elapsed the decision has already been made for us.
     *
     * The read is async and the rest of this loop is not, so the timer is
     * scheduled from inside the promise. A launch whose symbol read fails
     * still goes down the normal path rather than being dropped.
     */
    void symbolOf(launch.token).then((sym) => {
      const dep = launch.deployer.toLowerCase();
      const match = sym
        ? watches.find(
            (w) =>
              w.ticker.trim().toLowerCase() === sym.trim().toLowerCase() &&
              (!w.deployer || w.deployer.toLowerCase() === dep),
          )
        : undefined;
      const hit: TickerHit | null = match
        ? { ticker: match.ticker, pinnedDeployer: !!match.deployer, ethAmount: match.ethAmount }
        : null;
      if (hit) {
        logEngine(
          "info",
          `ticker watch matched ${sym} (${launch.token})${hit.pinnedDeployer ? "" : " — no deployer pinned"}`,
        );
      }
      const secs = hit ? cfg.tickerDelaySeconds : cfg.delaySeconds;
      const timer = setTimeout(() => enqueue(launch, l.blockNumber, hit), Math.max(0, secs) * 1000);
      if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
      s.pending.set(key, timer);
    });
  }
}

/** How often to check the subscription against the chain it claims to watch. */
const RECONCILE_MS = 60_000;

function arm(): void {
  s.unwatch?.();
  s.unwatch = publicClient().watchContractEvent({
    address: PONS.factory,
    abi: ponsFactoryAbi,
    eventName: "TokenLaunched",
    // Pushed via eth_subscribe when WSS_URL is set; polled on HTTP.
    pollingInterval: env.pollingIntervalMs,
    onLogs: (logs) => onLaunchLogs(logs as Log[]),
    onError: (err) => {
      // Swallowing this is how the watcher used to go silently blind: an
      // endpoint that starts refusing looks exactly like a chain with no
      // launches on it. Record it; the sweep below decides what to do.
      s.lastError = err instanceof Error ? err.message : String(err);
      logEngine("warn", `sniper watcher error: ${redactRpc(s.lastError)}`);
    },
  });
}

/**
 * Trust, but verify.
 *
 * A subscription that stops delivering is indistinguishable from a quiet chain,
 * so once a minute we ask an independent HTTP client what actually happened in
 * the blocks since the last check. Anything the live watcher failed to deliver
 * is both counted and processed, so a dead transport degrades into a slower
 * sniper rather than a stopped one. Repeated misses demote the WebSocket to
 * HTTP polling for good.
 */
async function reconcile(): Promise<void> {
  if (!s.running) return;
  try {
    const c = readClient();
    const head = await c.getBlockNumber();

    // First pass only establishes a baseline — everything before boot is not
    // ours to backfill.
    if (s.lastReconciledBlock === 0n) {
      s.lastReconciledBlock = head;
      return;
    }
    if (head <= s.lastReconciledBlock) return;

    // Cap the span so a long stall cannot ask for a range the endpoint refuses.
    const from = s.lastReconciledBlock + 1n;
    const to = head - from > 2_000n ? from + 2_000n : head;

    const logs = await c.getContractEvents({
      address: PONS.factory,
      abi: ponsFactoryAbi,
      eventName: "TokenLaunched",
      fromBlock: from,
      toBlock: to,
    });
    s.lastReconciledBlock = to;

    // handleLaunchLogs de-dupes on s.seen, so anything the subscription already
    // delivered is dropped here and only genuine misses survive.
    const before = s.launchesSeen;
    onLaunchLogs(logs as Log[]);
    const missed = s.launchesSeen - before;
    if (missed <= 0) return;

    s.missed += missed;
    logEngine(
      "warn",
      `sniper sweep found ${missed} launch(es) the live watcher missed (blocks ${from}-${to})`,
    );

    // One miss can be a race at the block boundary. A sweep that finds the
    // whole window means the subscription is not delivering at all.
    if (isWebSocket() && missed >= 3 && demoteWebSocket("subscription stopped delivering launches")) {
      logEngine("warn", "sniper: WebSocket demoted to HTTP polling after missed launches");
      arm();
    }
  } catch (err) {
    s.lastError = err instanceof Error ? err.message : String(err);
    logEngine("warn", `sniper sweep failed: ${redactRpc(s.lastError)}`);
  }
}

export function startSniper(): void {
  if (s.running) return;
  s.running = true;
  s.startedAt = Date.now();
  try {
    arm();
    logEngine("info", `sniper watcher started (factory ${PONS.factory})`);
  } catch (err) {
    s.running = false;
    logEngine("error", `sniper failed to start: ${String(err)}`);
    return;
  }

  s.reconcile = setInterval(() => void reconcile(), RECONCILE_MS);
  if (s.reconcile && typeof s.reconcile === "object" && "unref" in s.reconcile) {
    s.reconcile.unref();
  }
  void reconcile();
}

export function stopSniper(): void {
  s.running = false;
  s.unwatch?.();
  s.unwatch = undefined;
  if (s.reconcile) clearInterval(s.reconcile);
  s.reconcile = undefined;
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
    /** Launches recovered by the sweep because the subscription missed them. */
    missed: s.missed,
    wsDemoted: webSocketDemotedReason(),
    spentTodayEth: spentTodayEth(),
    snipesLastHour: snipesLastHour(),
    openSnipes: countOpenBySource("sniper"),
    lastError: s.lastError,
    recent,
  };
}
