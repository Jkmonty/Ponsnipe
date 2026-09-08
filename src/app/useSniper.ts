"use client";

/**
 * Snipe a coin you are already waiting for.
 *
 * Not the sniper that buys every launch and hopes. That one was measured
 * across roughly 1,500 strategy variants and about 4.9 million simulated
 * trades, and buying indiscriminately lost money under every exit rule tested.
 * This is the other thing entirely: you know the ticker, you may know the
 * wallet, and you want to be in the moment it exists rather than whenever you
 * happen to be looking.
 *
 * There is no filter here on purpose. A watch is not a strategy — it is a
 * decision already made — so the only judgement this file makes is "is this
 * the coin you named", and the only limits it enforces are the ones the trader
 * set themselves.
 *
 * What it cannot do is run with the tab closed. The key lives in this browser,
 * so the watch lives as long as the page does. Every place a watch is shown
 * says so, because a snipe you believe is armed and is not is worse than no
 * snipe at all.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getAddress, type Address } from "viem";
import { addSpentToday, readSpentToday, type Limits } from "./limits";

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
}

export interface SniperHit {
  ticker: string;
  token: string;
  at: number;
  ok: boolean;
  detail: string;
}

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

/** A feed row, cut down to what a watch actually reads. */
interface FeedRow {
  token: string;
  symbol: string;
  deployer: string;
  ageMinutes: number;
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
}

/**
 * Watch the feed and buy when a named coin appears.
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
  const [firing, setFiring] = useState<string | null>(null);
  const [recent, setRecent] = useState<SniperHit[]>([]);
  /** Tokens already handled, so a slow buy is not started twice. */
  const seen = useRef<Set<string>>(new Set());
  const inFlight = useRef(false);

  useEffect(() => setWatches(readWatches(owner)), [owner]);

  const persist = useCallback(
    (next: Watch[]) => {
      if (!owner) return;
      writeWatches(owner, next);
      setWatches(next);
    },
    [owner],
  );

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

  const active = watches.filter(
    (w) => w.bought < w.maxBuys && w.expiresAt > Date.now(),
  );
  const armed = active.length;

  /*
   * Poll only while something is armed.
   *
   * The feed page already holds a stream open; this deliberately does not open
   * a second one. Two seconds is well inside the window that matters here —
   * the coin is seconds old either way — and it costs nothing at all for the
   * many traders who have no watch set.
   */
  useEffect(() => {
    if (!unlocked || !owner || armed === 0) return;
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
      for (const row of rows) {
        const key = row.token.toLowerCase();
        if (seen.current.has(key)) continue;
        // Anything already old was not launched while we were watching.
        if (row.ageMinutes > MAX_AGE_MINUTES) {
          seen.current.add(key);
          continue;
        }

        const w = current.find(
          (x) =>
            x.bought < x.maxBuys &&
            x.expiresAt > Date.now() &&
            x.ticker.trim().toLowerCase() === (row.symbol ?? "").trim().toLowerCase() &&
            // Empty deployer means any maker; otherwise it must be theirs.
            (!x.deployer.trim() ||
              x.deployer.trim().toLowerCase() === (row.deployer ?? "").toLowerCase()),
        );
        if (!w) continue;

        // Claim it before the await, so the next tick cannot buy it again.
        seen.current.add(key);

        const amount = Number(w.eth) || 0;
        const spent = readSpentToday();
        if (amount > limits.perTrade) {
          setRecent((r) => [
            { ticker: w.ticker, token: row.token, at: Date.now(), ok: false,
              detail: `over your ${limits.perTrade} ETH per-trade limit` },
            ...r,
          ].slice(0, 6));
          continue;
        }
        if (spent + amount > limits.perDay) {
          setRecent((r) => [
            { ticker: w.ticker, token: row.token, at: Date.now(), ok: false,
              detail: `would pass your ${limits.perDay} ETH daily limit` },
            ...r,
          ].slice(0, 6));
          continue;
        }

        inFlight.current = true;
        setFiring(row.token);
        try {
          await buy(getAddress(row.token), w.eth);
          addSpentToday(amount);
          // Credit the watch so it disarms itself rather than firing again on
          // the next coin of the same name.
          persist(
            readWatches(owner).map((x) =>
              x.id === w.id ? { ...x, bought: x.bought + 1 } : x,
            ),
          );
          setRecent((r) => [
            { ticker: w.ticker, token: row.token, at: Date.now(), ok: true,
              detail: `bought for ${w.eth} ETH` },
            ...r,
          ].slice(0, 6));
        } catch (e) {
          setRecent((r) => [
            { ticker: w.ticker, token: row.token, at: Date.now(), ok: false,
              detail: (e instanceof Error ? e.message : "buy failed").split("\n")[0] },
            ...r,
          ].slice(0, 6));
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
  }, [unlocked, owner, armed, limits, buy, persist]);

  return { watches, armed, add, remove, firing, recent };
}
