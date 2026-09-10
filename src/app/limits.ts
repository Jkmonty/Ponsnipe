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

/**
 * Is `amount` within `cap`?
 *
 * Zero, blank or anything not a number means no cap. The fields were always
 * editable, but there was no way to say "no limit" — you could only type a
 * number large enough to hope it never bound, which is a worse version of the
 * same thing because it still fails at some size you have forgotten about.
 *
 * One function rather than a comparison at each of the four call sites, for
 * the reason this file exists at all: a cap enforced in one place and ignored
 * in another is the failure mode worth designing out.
 */
export function within(amount: number, cap: number): boolean {
  if (!Number.isFinite(cap) || cap <= 0) return true;
  return amount <= cap;
}

/** How a cap reads on screen, including when it is off. */
export function capText(cap: number): string {
  return !Number.isFinite(cap) || cap <= 0 ? "no limit" : `${cap} ETH`;
}

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
