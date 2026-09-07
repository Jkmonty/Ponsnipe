"use client";

/**
 * Spend limits, kept apart from the panel that used to own them.
 *
 * They were declared inside TradePanel, which was fine while the panel was the
 * only thing that could spend. Now the wallet menu edits them and the buy form
 * enforces them, and two copies of "what is the daily cap" is exactly the kind
 * of split that lets a cap be shown in one place and ignored in another.
 */

const LIMITS_KEY = "ponsnipe.limits.v1";
const SPENT_KEY = "ponsnipe.spentToday.v1";

export interface Limits {
  perTrade: number;
  perDay: number;
}

export const DEFAULT_LIMITS: Limits = { perTrade: 0.05, perDay: 0.25 };

export function readLimits(): Limits {
  try {
    const r = localStorage.getItem(LIMITS_KEY);
    return r ? { ...DEFAULT_LIMITS, ...JSON.parse(r) } : DEFAULT_LIMITS;
  } catch {
    return DEFAULT_LIMITS;
  }
}

export function writeLimits(l: Limits): void {
  try {
    localStorage.setItem(LIMITS_KEY, JSON.stringify(l));
  } catch {
    /* private mode: the cap holds for this session and no longer */
  }
}

/** Spend so far today, reset by date so a forgotten cap does not last forever. */
export function readSpentToday(): number {
  try {
    const r = JSON.parse(localStorage.getItem(SPENT_KEY) ?? "{}") as { d?: string; v?: number };
    return r.d === new Date().toISOString().slice(0, 10) ? (r.v ?? 0) : 0;
  } catch {
    return 0;
  }
}

export function addSpentToday(eth: number): void {
  try {
    localStorage.setItem(
      SPENT_KEY,
      JSON.stringify({ d: new Date().toISOString().slice(0, 10), v: readSpentToday() + eth }),
    );
  } catch {
    /* private mode; the cap simply does not persist */
  }
}
