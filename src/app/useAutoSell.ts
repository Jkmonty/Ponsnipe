"use client";

/**
 * Take-profit and stop-loss, for as long as the tab is open.
 *
 * The local install sells while you sleep because it holds a key that can sign
 * unattended. A page cannot promise that — close the tab and nothing runs. But
 * the trading key can sign without prompting, so between opening the page and
 * closing it, rules can be enforced. That is a real feature and a real limit,
 * and this file exists to make sure the limit is never overstated.
 *
 * What it deliberately does not do is pretend. Every place a rule is shown says
 * it needs the tab open, and arming one is what tells the wallet not to idle
 * out from under it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { reduceBasis, type Holding } from "./usePositions";

const STORE = "ponsnipe.autosell.v1";

/** How often armed rules are checked against fresh prices. */
export const WATCH_INTERVAL_MS = 8_000;

export interface Rule {
  /** Sell when up this many percent. null = no take-profit. */
  tp: number | null;
  /** Sell when down this many percent. null = no stop-loss. */
  sl: number | null;
  /**
   * How much of the position the take-profit sells, as a percentage.
   *
   * Defaults to all of it. Selling part is the common move on a launch — take
   * enough back to cover the stake, let the rest run — and it only applies to
   * the take-profit. A stop-loss that sells half is not a stop: the point of
   * one is to be out, and a slower loss is still a loss.
   */
  tpSellPct?: number;
}

type Store = Record<string, Record<string, Rule>>;

function readAll(): Store {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "{}") as Store;
  } catch {
    return {};
  }
}

export function readRules(owner: Address | null): Record<string, Rule> {
  if (!owner) return {};
  return readAll()[owner.toLowerCase()] ?? {};
}

export function setRule(owner: Address, token: string, rule: Rule | null): void {
  try {
    const all = readAll();
    const key = owner.toLowerCase();
    const mine = all[key] ?? {};
    if (rule && (rule.tp != null || rule.sl != null)) mine[token.toLowerCase()] = rule;
    else delete mine[token.toLowerCase()];
    all[key] = mine;
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch {
    /* private mode: rules simply will not survive a reload */
  }
}

export interface AutoSell {
  rules: Record<string, Rule>;
  /** How many holdings currently have a rule armed. */
  armed: number;
  /** Bumped on the watch interval; feed it to usePositions as its refresh key. */
  tick: number;
  save: (token: string, rule: Rule | null) => void;
  /** Token address currently being sold by a rule, if any. */
  firing: string | null;
  lastFired: { symbol: string; reason: string; at: number } | null;
}

/**
 * Watch armed holdings and sell when a rule is met.
 *
 * `sell` is the same function the manual button uses, so an automatic exit and
 * a hand-pressed one cannot diverge — there is one selling path, not two.
 */
export function useAutoSell(
  owner: Address | null,
  unlocked: boolean,
  holdings: Holding[],
  sell: (h: Holding, sellPct: number) => Promise<void>,
): AutoSell {
  const [rules, setRules] = useState<Record<string, Rule>>({});
  const [tick, setTick] = useState(0);
  const [firing, setFiring] = useState<string | null>(null);
  const [lastFired, setLastFired] = useState<AutoSell["lastFired"]>(null);
  /** Tokens already being sold, so a slow sell is not started twice. */
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => setRules(readRules(owner)), [owner]);

  const save = useCallback(
    (token: string, rule: Rule | null) => {
      if (!owner) return;
      setRule(owner, token, rule);
      setRules(readRules(owner));
    },
    [owner],
  );

  const armed = holdings.filter((h) => {
    const r = rules[h.token.toLowerCase()];
    return !!r && (r.tp != null || r.sl != null);
  }).length;

  /*
   * Only tick while there is something to watch.
   *
   * A timer that runs regardless would re-read every holding from the chain
   * every eight seconds for a trader who has armed nothing at all.
   */
  useEffect(() => {
    if (!unlocked || armed === 0) return;
    const iv = setInterval(() => setTick((n) => n + 1), WATCH_INTERVAL_MS);
    return () => clearInterval(iv);
  }, [unlocked, armed]);

  /*
   * Check the rules against whatever the last refresh returned.
   *
   * Driven by the holdings themselves rather than by the timer, so a rule is
   * judged on prices that have actually been re-read — a timer firing against
   * stale numbers would sell on a price from a minute ago.
   */
  useEffect(() => {
    if (!unlocked || !owner) return;
    for (const h of holdings) {
      const r = rules[h.token.toLowerCase()];
      if (!r || h.pnlPct == null) continue;
      // No cost basis, no percentage to compare: a holding whose record was
      // lost with site data must not be sold against a number we do not have.
      const hitTp = r.tp != null && h.pnlPct >= r.tp;
      const hitSl = r.sl != null && h.pnlPct <= -Math.abs(r.sl);
      if (!hitTp && !hitSl) continue;

      const key = h.token.toLowerCase();
      if (inFlight.current.has(key)) continue;
      inFlight.current.add(key);
      setFiring(h.token);

      /*
       * A stop always sells everything; a take-profit sells what it was told
       * to. Clamped, because a hand-typed percentage over 100 would ask the
       * curve for more tokens than the wallet holds and simply revert.
       */
      const pct = hitTp ? Math.max(1, Math.min(100, r.tpSellPct ?? 100)) : 100;

      void sell(h, pct)
        .then(() => {
          setLastFired({
            symbol: h.symbol,
            reason:
              (hitTp ? `hit +${r.tp}%` : `hit -${Math.abs(r.sl!)}%`) +
              (pct < 100 ? ` — sold ${pct}%` : ""),
            at: Date.now(),
          });
          if (pct >= 100) {
            // Nothing left to act on; leaving the rule armed would fire again
            // on a position that no longer exists.
            save(h.token, null);
            return;
          }
          /*
           * A partial sell leaves a live position, so two things have to
           * happen together.
           *
           * The basis shrinks with the tokens, or the remainder reads as a
           * heavy loss and its own stop-loss dumps it on the next tick. And
           * the take-profit clears while the stop-loss stays: the price has
           * not moved, so an armed take-profit would fire again immediately
           * and keep selling the position in slices.
           */
          reduceBasis(owner, h.token, 100 - pct);
          save(h.token, { tp: null, sl: r.sl, tpSellPct: r.tpSellPct });
        })
        .catch(() => {
          /* left armed on purpose: a failed sell should be retried next tick */
        })
        .finally(() => {
          inFlight.current.delete(key);
          setFiring(null);
        });
      // One at a time: two sells racing would each spend gas fighting the other
      // for the same nonce.
      break;
    }
  }, [holdings, rules, unlocked, owner, sell, save]);

  return { rules, armed, tick, save, firing, lastFired };
}
