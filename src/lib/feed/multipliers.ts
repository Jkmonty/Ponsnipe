/**
 * Dividends, as this chain actually pays them.
 *
 * Robinhood's stock tokens are ERC-8056 "scaled UI" tokens: a dividend or a
 * split does not move anybody's balance. Instead the contract raises a
 * multiplier, and one raw token comes to represent `multiplier` underlying
 * shares. Balances stay where they are; what they are worth changes.
 *
 * That matters here for two separate reasons.
 *
 * The first is correctness. usd.ts prices these by looking up the share price
 * and treating the token as one share — which was true at launch and stops
 * being true at the first dividend. NVDA already sits at 1.000775, so every
 * NVDA-quoted market cap in the feed reads about 0.08% low, and the gap only
 * ever widens because the multiplier ratchets and never falls.
 *
 * The second is that it is worth showing. Forty-two percent of live pons
 * launches are priced against these tokens, which means a trader holding one
 * of those positions is collecting dividend equivalents without being told.
 * The contract also publishes the *next* adjustment before it lands, through
 * `newUIMultiplier()` and `effectiveAt()` — so a dividend is visible in
 * advance rather than only in hindsight.
 */
import { parseAbi, type Address } from "viem";
import { readClient } from "../chain";

/** The slice of ERC-8056 worth reading. */
const scaledUiAbi = parseAbi([
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
]);

const WAD = 10n ** 18n;
/**
 * Re-read this often. Corporate actions happen on a calendar, not a tick, so
 * anything under an hour is asking the chain a question whose answer changed
 * last quarter.
 */
const TTL_MS = 15 * 60_000;

export interface Multiplier {
  /** Shares per raw token, 1 when the token has no multiplier at all. */
  now: number;
  /** The next value, when one is scheduled and differs from the current. */
  next: number | null;
  /** When `next` takes effect, in ms. */
  at: number | null;
  /** False for tokens that are not scaled-UI at all — stablecoins, WETH. */
  scaled: boolean;
  readAt: number;
}

const NONE: Multiplier = { now: 1, next: null, at: null, scaled: false, readAt: 0 };

const g = globalThis as typeof globalThis & { __ponsMultipliers?: Map<string, Multiplier> };
function cache(): Map<string, Multiplier> {
  g.__ponsMultipliers ??= new Map();
  return g.__ponsMultipliers;
}

/**
 * Read one token's multiplier, or report that it has none.
 *
 * A token that does not implement the interface is the normal case, not a
 * failure: USDG, WETH and every crypto quote asset revert here, and the right
 * answer for them is a multiplier of exactly one.
 */
async function read(address: Address): Promise<Multiplier> {
  const c = readClient();
  const [now, next, at] = await Promise.all([
    c.readContract({ address, abi: scaledUiAbi, functionName: "uiMultiplier" }).catch(() => null),
    c.readContract({ address, abi: scaledUiAbi, functionName: "newUIMultiplier" }).catch(() => null),
    c.readContract({ address, abi: scaledUiAbi, functionName: "effectiveAt" }).catch(() => null),
  ]);
  if (now == null) return { ...NONE, readAt: Date.now() };

  const asNumber = (v: bigint) => Number((v * 1_000_000n) / WAD) / 1_000_000;
  const current = asNumber(now as bigint);
  const pending = next == null ? null : asNumber(next as bigint);
  const when = at == null ? null : Number(at as bigint) * 1000;
  return {
    now: current,
    // Only a *different* pending value is news. The contract reports the
    // current one here once an adjustment has taken effect, and showing "a
    // dividend is coming" for one that already landed would be a lie with a
    // timestamp on it.
    next: pending != null && pending !== current ? pending : null,
    at: pending != null && pending !== current ? when : null,
    scaled: true,
    readAt: Date.now(),
  };
}

/** Multipliers for a set of quote tokens, cached and read in parallel. */
export async function multipliersFor(
  tokens: { symbol: string; address: string }[],
): Promise<Map<string, Multiplier>> {
  const out = new Map<string, Multiplier>();
  const stale: { symbol: string; address: string }[] = [];
  const now = Date.now();

  for (const t of tokens) {
    const hit = cache().get(t.symbol.toUpperCase());
    if (hit && now - hit.readAt < TTL_MS) out.set(t.symbol.toUpperCase(), hit);
    else stale.push(t);
  }

  await Promise.all(
    stale.map(async (t) => {
      try {
        const m = await read(t.address as Address);
        cache().set(t.symbol.toUpperCase(), m);
        out.set(t.symbol.toUpperCase(), m);
      } catch {
        // An unreadable multiplier must not blank a price. One is the honest
        // fallback: it is what the token was worth before any dividend, so the
        // error is in the safe direction — understating, never inventing.
        out.set(t.symbol.toUpperCase(), { ...NONE, readAt: now });
      }
    }),
  );
  return out;
}

/** What is cached right now, without going to the chain. */
export function knownMultiplier(symbol: string): Multiplier {
  return cache().get(symbol.toUpperCase()) ?? NONE;
}

/**
 * Dividends accrued since the token launched, as a percentage.
 *
 * The multiplier starts at exactly 1 and only rises, so the distance above one
 * is the whole dividend history of that share since it was tokenised.
 */
export function accruedPct(m: Multiplier): number {
  return (m.now - 1) * 100;
}
