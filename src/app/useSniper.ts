"use client";

/**
 * The sniper, running in the trader's own browser.
 *
 * Two modes, and the difference between them matters.
 *
 * A WATCH is a coin you already named: a ticker, usually a deployer, and an
 * amount. No filter is applied to it, because a watch is not a strategy — it
 * is a decision already made. Judging it on holder counts would reject the
 * launch you had been waiting a week for, four seconds after it appeared.
 *
 * The RULES are the other thing: buy launches nobody named, if they pass a
 * test. This is the mode that spends money on coins the trader has never seen,
 * so it ships off, with restrictive defaults, an hourly ceiling, and a log
 * that says why every skipped coin was skipped. That last part is not a nicety
 * — a sniper that will not tell you why it passed is one you cannot tune.
 *
 * The defaults lean cautious because the research says to. Roughly 1,500
 * strategy variants over about 4.9 million simulated trades: buying launches
 * indiscriminately lost money under every exit rule tested, and only filters
 * about who else had already bought ever flipped it positive.
 *
 * What none of it can do is run with the tab closed. The key lives in this
 * browser, so the sniper lives as long as the page does. Every place it is
 * shown says so, because a snipe you believe is armed and is not is worse than
 * no snipe at all.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getAddress, type Address } from "viem";
import { addSpentToday, capText, readSpentToday, within, type Limits } from "./limits";
import { setRule } from "./useAutoSell";

const STORE = "ponsnipe.watches.v1";

/** How often the feed is re-read while a watch is armed. */
export const WATCH_POLL_MS = 2_000;

/**
 * Ignore anything already older than this when a watch first arms.
 *
 * Without it, arming a watch for a ticker that launched an hour ago would buy
 * it instantly — the feed holds 250 coins and most of them are not news. A
 * watch is for what happens next.
 */
const MAX_AGE_MINUTES = 2;

export interface Watch {
  id: string;
  /** Matched against the token symbol, exactly, case-insensitively. */
  ticker: string;
  /**
   * Only this deployer counts. Empty means any, which is the risky mode:
   * VLAD has launched 530 times from different makers and TEST 605 times, so
   * a ticker-only watch will usually fire on a squatter rather than on the
   * launch you meant.
   */
  deployer: string;
  /** ETH to spend, as a string so the input owns its own formatting. */
  eth: string;
  /** Stop after this many buys. */
  maxBuys: number;
  bought: number;
  /** Epoch ms after which this watch is ignored. */
  expiresAt: number;
  armedAt: number;
  /**
   * Exit rules to arm on whatever this buys, in percent. null = none.
   *
   * They belong on the watch rather than only on the holding it produces,
   * because the entire premise of a snipe is that you are not at the screen
   * when it fires. Rules that can only be set afterwards mean the position
   * spends the gap between filling and you noticing with no stop on it — and
   * that gap is the whole reason the feature exists.
   */
  tp: number | null;
  sl: number | null;
  /** How much of the position the take-profit sells, as a percentage. */
  tpSellPct: number;
}

export interface SniperHit {
  ticker: string;
  token: string;
  at: number;
  ok: boolean;
  detail: string;
}

/**
 * Rules for buying launches nobody named in advance.
 *
 * Off by default and it stays off until someone turns it on, because this is
 * the mode that spends money on coins the trader has never seen. Every field
 * maps to something the feed already carries, so the whole decision is made
 * in the browser from data that was going to be fetched anyway.
 *
 * The defaults are not neutral. Roughly 1,500 strategy variants over 4.9
 * million simulated trades say buying launches indiscriminately loses money
 * under every exit rule tested, and the only filters that flipped it positive
 * were about who else had bought. So the stock settings are the restrictive
 * ones — a trader who wants to buy everything has to take the guards off
 * deliberately rather than arrive at it by leaving the form alone.
 */
export interface AutoConfig {
  enabled: boolean;
  /** ETH per snipe. */
  eth: string;
  /** Hard ceiling on how often this can fire, whatever the rules say. */
  maxPerHour: number;
  /** Skip a launch with fewer holders than this. */
  minHolders: number;
  /** Skip when the top 10 wallets hold more than this share, as a percent. */
  maxTop10Pct: number;
  /** Skip launches with a detected operator bundle. */
  skipBundled: boolean;
  /** Skip when the deployer has already sold any of their own. */
  skipDevSold: boolean;
  /** Only buy ETH-quoted coins, avoiding the swap a stock-quoted one needs. */
  ethOnly: boolean;
  /** Exit rules armed on everything this buys, in percent. null = none. */
  tp: number | null;
  sl: number | null;
  /** How much of the position the take-profit sells, as a percentage. */
  tpSellPct: number;
}

export const DEFAULT_AUTO: AutoConfig = {
  enabled: false,
  eth: "0.01",
  maxPerHour: 3,
  minHolders: 3,
  maxTop10Pct: 40,
  skipBundled: true,
  skipDevSold: true,
  ethOnly: true,
  /* A default stop, because an unattended buy with no exit is the one
     combination in this app that can lose everything while you are away. */
  tp: 50,
  sl: 25,
  /* Sell most of it at the target and let a slice run. Taking the stake back
     and keeping some upside is the usual move on a launch, and it is a better
     default than closing the whole position at the first target. */
  tpSellPct: 70,
};

/** One line in the log: what the sniper saw and what it did about it. */
export interface LogEntry {
  at: number;
  symbol: string;
  token: string;
  decision: "bought" | "skipped" | "error";
  reason: string;
}

/** Kept short. This is a record of what just happened, not an archive. */
const LOG_MAX = 60;

type Store = Record<string, Watch[]>;

function readAll(): Store {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "{}") as Store;
  } catch {
    return {};
  }
}

export function readWatches(owner: Address | null): Watch[] {
  if (!owner) return [];
  return readAll()[owner.toLowerCase()] ?? [];
}

function writeWatches(owner: Address, list: Watch[]): void {
  try {
    const all = readAll();
    all[owner.toLowerCase()] = list;
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch {
    /* private mode: watches hold for this session and no longer */
  }
}

/** A feed row, cut down to what the sniper actually reads. */
interface FeedRow {
  token: string;
  symbol: string;
  deployer: string;
  ageMinutes: number;
  holders: number;
  /** Share held by the top ten wallets, 0-1. */
  top10Rate: number;
  /** How many wallets of a detected operator cluster bought in. */
  bundled: number;
  devSold: boolean;
  quoteSymbol: string;
}

const CFG_STORE = "ponsnipe.autosnipe.v1";
const LOG_STORE = "ponsnipe.snipelog.v1";

function readCfg(owner: Address | null): AutoConfig {
  if (!owner) return DEFAULT_AUTO;
  try {
    const all = JSON.parse(localStorage.getItem(CFG_STORE) ?? "{}") as Record<string, AutoConfig>;
    // Merged over the defaults rather than used raw, so a config saved before
    // a field existed does not come back with that field undefined.
    return { ...DEFAULT_AUTO, ...(all[owner.toLowerCase()] ?? {}) };
  } catch {
    return DEFAULT_AUTO;
  }
}

function writeCfg(owner: Address, cfg: AutoConfig): void {
  try {
    const all = JSON.parse(localStorage.getItem(CFG_STORE) ?? "{}") as Record<string, AutoConfig>;
    all[owner.toLowerCase()] = cfg;
    localStorage.setItem(CFG_STORE, JSON.stringify(all));
  } catch {
    /* private mode: the rules hold for this session and no longer */
  }
}

function readLog(owner: Address | null): LogEntry[] {
  if (!owner) return [];
  try {
    const all = JSON.parse(localStorage.getItem(LOG_STORE) ?? "{}") as Record<string, LogEntry[]>;
    return all[owner.toLowerCase()] ?? [];
  } catch {
    return [];
  }
}

function writeLog(owner: Address, list: LogEntry[]): void {
  try {
    const all = JSON.parse(localStorage.getItem(LOG_STORE) ?? "{}") as Record<string, LogEntry[]>;
    all[owner.toLowerCase()] = list.slice(0, LOG_MAX);
    localStorage.setItem(LOG_STORE, JSON.stringify(all));
  } catch {
    /* private mode */
  }
}

/**
 * Why this launch is not being bought, or null if it is.
 *
 * Returns the reason rather than a boolean, so the log can say "top 10 hold
 * 71%" instead of "skipped". A sniper that will not tell you why it passed on
 * something is a sniper you cannot tune.
 */
function rejectReason(row: FeedRow, cfg: AutoConfig): string | null {
  if (cfg.ethOnly && (row.quoteSymbol ?? "").toUpperCase() !== "ETH") {
    return `priced in ${row.quoteSymbol || "?"}, not ETH`;
  }
  if (cfg.skipBundled && (row.bundled ?? 0) > 0) {
    return `${row.bundled} wallets look like one operator`;
  }
  if (cfg.skipDevSold && row.devSold) return "the dev has already sold";
  if ((row.holders ?? 0) < cfg.minHolders) {
    return `only ${row.holders ?? 0} holder${row.holders === 1 ? "" : "s"}`;
  }
  const top10 = Math.round((row.top10Rate ?? 0) * 100);
  if (top10 > cfg.maxTop10Pct) return `top 10 hold ${top10}%`;
  return null;
}

export interface Sniper {
  watches: Watch[];
  /** Armed = under its buy limit and not expired. */
  armed: number;
  add: (w: Omit<Watch, "id" | "bought" | "armedAt">) => void;
  remove: (id: string) => void;
  /** Token address currently being bought, if any. */
  firing: string | null;
  recent: SniperHit[];
  cfg: AutoConfig;
  setCfg: (next: AutoConfig) => void;
  log: LogEntry[];
  clearLog: () => void;
  /** Buys in the last hour, against cfg.maxPerHour. */
  firedThisHour: number;
  /** True when anything at all is watching the feed. */
  watching: boolean;
}

/**
 * Watch the feed and buy: coins you named, and coins that match your rules.
 *
 * `buy` is the same routine the manual button uses, so a sniped entry and a
 * hand-pressed one cannot diverge — there is one buying path, not two.
 */
export function useSniper(
  owner: Address | null,
  unlocked: boolean,
  limits: Limits,
  buy: (token: string, eth: string) => Promise<void>,
): Sniper {
  const [watches, setWatches] = useState<Watch[]>([]);
  const [cfg, setCfgState] = useState<AutoConfig>(DEFAULT_AUTO);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [firing, setFiring] = useState<string | null>(null);
  const [recent, setRecent] = useState<SniperHit[]>([]);
  /** Tokens already judged, so a slow buy is not started twice. */
  const seen = useRef<Set<string>>(new Set());
  const inFlight = useRef(false);

  useEffect(() => {
    setWatches(readWatches(owner));
    setCfgState(readCfg(owner));
    setLog(readLog(owner));
  }, [owner]);

  const persist = useCallback(
    (next: Watch[]) => {
      if (!owner) return;
      writeWatches(owner, next);
      setWatches(next);
    },
    [owner],
  );

  const setCfg = useCallback(
    (next: AutoConfig) => {
      if (!owner) return;
      writeCfg(owner, next);
      setCfgState(next);
    },
    [owner],
  );

  const note = useCallback(
    (e: LogEntry) => {
      if (!owner) return;
      const next = [e, ...readLog(owner)].slice(0, LOG_MAX);
      writeLog(owner, next);
      setLog(next);
    },
    [owner],
  );

  const clearLog = useCallback(() => {
    if (!owner) return;
    writeLog(owner, []);
    setLog([]);
  }, [owner]);

  const add = useCallback(
    (w: Omit<Watch, "id" | "bought" | "armedAt">) => {
      if (!owner) return;
      persist([
        ...readWatches(owner),
        { ...w, id: crypto.randomUUID(), bought: 0, armedAt: Date.now() },
      ]);
    },
    [owner, persist],
  );

  const remove = useCallback(
    (id: string) => {
      if (!owner) return;
      persist(readWatches(owner).filter((w) => w.id !== id));
    },
    [owner, persist],
  );

  const armed = watches.filter(
    (w) => w.bought < w.maxBuys && w.expiresAt > Date.now(),
  ).length;
  const firedThisHour = log.filter(
    (e) => e.decision === "bought" && e.at > Date.now() - 3600_000,
  ).length;
  const watching = unlocked && (armed > 0 || cfg.enabled);

  /*
   * Poll only while something is watching.
   *
   * The feed page already holds a stream open; this deliberately does not open
   * a second one. Two seconds is well inside the window that matters — the
   * coin is seconds old either way — and it costs nothing at all for the many
   * traders who have neither a watch nor the rules turned on.
   */
  useEffect(() => {
    if (!watching || !owner) return;
    let stop = false;

    const tick = async () => {
      if (stop || inFlight.current) return;
      let rows: FeedRow[];
      try {
        const r = await fetch("/api/feed?limit=60");
        rows = ((await r.json()) as { rows?: FeedRow[] }).rows ?? [];
      } catch {
        return; // transient; the next tick tries again
      }

      const current = readWatches(owner);
      const rules = readCfg(owner);

      for (const row of rows) {
        const key = row.token.toLowerCase();
        if (seen.current.has(key)) continue;
        // Anything already old was not launched while we were watching.
        if (row.ageMinutes > MAX_AGE_MINUTES) {
          seen.current.add(key);
          continue;
        }

        /*
         * A named watch beats the rules, and skips them.
         *
         * You asked for this exact coin. Applying "must already have three
         * holders" to something four seconds old that you have been waiting a
         * week for would reject it every time, which is not what arming a
         * watch means.
         */
        const w = current.find(
          (x) =>
            x.bought < x.maxBuys &&
            x.expiresAt > Date.now() &&
            x.ticker.trim().toLowerCase() === (row.symbol ?? "").trim().toLowerCase() &&
            (!x.deployer.trim() ||
              x.deployer.trim().toLowerCase() === (row.deployer ?? "").toLowerCase()),
        );

        let spendEth: string;
        if (w) {
          spendEth = w.eth;
        } else if (rules.enabled) {
          const why = rejectReason(row, rules);
          if (why) {
            seen.current.add(key);
            note({ at: Date.now(), symbol: row.symbol, token: row.token, decision: "skipped", reason: why });
            continue;
          }
          if (firedThisHour >= rules.maxPerHour) {
            seen.current.add(key);
            note({
              at: Date.now(), symbol: row.symbol, token: row.token, decision: "skipped",
              reason: `already bought ${rules.maxPerHour} this hour`,
            });
            continue;
          }
          spendEth = rules.eth;
        } else {
          continue;
        }

        // Claim it before the await, so the next tick cannot buy it again.
        seen.current.add(key);

        const amount = Number(spendEth) || 0;
        const spentSoFar = readSpentToday();
        if (!within(amount, limits.perTrade)) {
          note({
            at: Date.now(), symbol: row.symbol, token: row.token, decision: "skipped",
            reason: `over your ${capText(limits.perTrade)} per-trade limit`,
          });
          continue;
        }
        if (!within(spentSoFar + amount, limits.perDay)) {
          note({
            at: Date.now(), symbol: row.symbol, token: row.token, decision: "skipped",
            reason: `would pass your ${capText(limits.perDay)} daily limit`,
          });
          continue;
        }

        inFlight.current = true;
        setFiring(row.token);
        try {
          await buy(getAddress(row.token), spendEth);
          addSpentToday(amount);
          if (w) {
            // Credit the watch so it disarms itself rather than firing again
            // on the next coin of the same name.
            persist(
              readWatches(owner).map((x) =>
                x.id === w.id ? { ...x, bought: x.bought + 1 } : x,
              ),
            );
            setRecent((r) =>
              [
                { ticker: w.ticker, token: row.token, at: Date.now(), ok: true, detail: `bought for ${spendEth} ETH` },
                ...r,
              ].slice(0, 6),
            );
          }
          /*
           * The exit is armed in the same breath as the entry.
           *
           * Not on the next render, and not when the trader next looks at the
           * panel: the position is unprotected for every second between those,
           * and a snipe fires precisely when nobody is watching.
           */
          const exit = w
            ? { tp: w.tp, sl: w.sl, tpSellPct: w.tpSellPct }
            : { tp: rules.tp, sl: rules.sl, tpSellPct: rules.tpSellPct };
          if (exit.tp != null || exit.sl != null) setRule(owner, row.token, exit);

          note({
            at: Date.now(), symbol: row.symbol, token: row.token, decision: "bought",
            reason:
              (w ? `matched your ${w.ticker} watch · ${spendEth} ETH` : `${spendEth} ETH`) +
              (exit.tp != null || exit.sl != null
                ? ` · exit ${exit.tp != null ? `+${exit.tp}%` : "—"} / ${exit.sl != null ? `-${exit.sl}%` : "—"}`
                : ""),
          });
        } catch (e) {
          const detail = (e instanceof Error ? e.message : "buy failed").split("\n")[0];
          if (w) {
            setRecent((r) =>
              [{ ticker: w.ticker, token: row.token, at: Date.now(), ok: false, detail }, ...r].slice(0, 6),
            );
          }
          note({ at: Date.now(), symbol: row.symbol, token: row.token, decision: "error", reason: detail });
        } finally {
          inFlight.current = false;
          setFiring(null);
        }
        // One at a time: two buys racing would fight over the same nonce.
        break;
      }
    };

    void tick();
    const iv = setInterval(() => void tick(), WATCH_POLL_MS);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, [watching, owner, limits, buy, persist, note, firedThisHour]);

  return {
    watches,
    armed,
    add,
    remove,
    firing,
    recent,
    cfg,
    setCfg,
    log,
    clearLog,
    firedThisHour,
    watching,
  };
}
