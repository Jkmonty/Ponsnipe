/**
 * What the sniper would have bought, surfaced for a human to decide on.
 *
 * The engine already evaluates every launch whether or not it is armed — when
 * it is off it records the verdict as a "DRY-RUN: would snipe" event rather
 * than spending. That log is the suggestion list; this module reads it back,
 * re-prices the survivors, and ranks them.
 *
 * Ranking is by early-buyer count, which is the only pre-entry signal that
 * measured large in the research: 8+ other buyers in the first 20 seconds
 * graduate at 5.65% against 0.11% for none — a 51x spread that dwarfs every
 * other filter. It is not a promise, it is the least-bad ordering available.
 */
import { db } from "../db/index";
import { getTokenSnapshot } from "../pons/tokens";
import { recentGraduations } from "./graduations";
import { loadSniperConfig } from "./config";

export interface Suggestion {
  token: string;
  symbol: string;
  logo: string;
  quoteSymbol: string;
  /** "curve" = still on the bonding curve. "graduated" = now a v4 pool. */
  kind: "curve" | "graduated";
  ts: string;
  ageMinutes: number;
  /** Other wallets that had bought when the sniper looked. The ranking key. */
  otherBuys: number;
  /** Quote-token liquidity in the curve at evaluation time. */
  liquidity: number;
  /** Progress toward graduation, re-read live where possible. */
  gradPct: number;
  /** Passed every filter except the ETH-quote requirement — see the zap note. */
  blockedByQuote: boolean;
  /** Current price in the quote asset; 0 when it could not be re-read. */
  priceQuote: number;
  /** Multiple of the opening price, graduated tokens only. */
  mult: number | null;
  /** False when the curve has since graduated, stalled, or stopped pricing. */
  actionable: boolean;
  note: string;
}

export interface SuggestionSet {
  /** Live curves the filter chain approved. Ordered best-first. */
  preGraduation: Suggestion[];
  /** Recent graduations. A watchlist, not a buy list — see `caveat`. */
  postGraduation: Suggestion[];
  windowMinutes: number;
  /** Shown next to the list so the base rates travel with the suggestion. */
  caveat: string;
  generatedAt: string;
}

interface EventRow {
  ts: string;
  token_address: string;
  token_symbol: string | null;
  quote_symbol: string | null;
  liquidity: number | null;
  other_buys: number | null;
  grad_pct: number | null;
  blocked_by_quote: number | null;
  logo: string | null;
}

/** Re-pricing every candidate is several RPC reads, so do it at most this often. */
const TTL_MS = 12_000;
const gc = globalThis as typeof globalThis & {
  __ponsSuggestions?: { at: number; window: number; value: SuggestionSet };
};

function minutesSince(ts: string): number {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (Date.now() - t) / 60_000);
}

/**
 * The most recent "would snipe" verdict per token inside the window. Grouping
 * by token matters: a curve the engine re-evaluates on every trade against it
 * would otherwise fill the whole list with one name.
 */
function approvedCandidates(windowMinutes: number): EventRow[] {
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  try {
    return db()
      .prepare(
        `SELECT ts, token_address, token_symbol, quote_symbol, liquidity,
                other_buys, grad_pct, blocked_by_quote, logo
           FROM sniper_events
          WHERE ts >= ?
            AND reason LIKE 'DRY-RUN: would snipe%'
            AND id IN (SELECT MAX(id) FROM sniper_events GROUP BY token_address)
          ORDER BY id DESC
          LIMIT 12`,
      )
      .all(since) as unknown as EventRow[];
  } catch {
    return [];
  }
}

async function enrich(row: EventRow): Promise<Suggestion> {
  const otherBuys = row.other_buys ?? 0;
  const blockedByQuote = row.blocked_by_quote === 1;

  const snap = await getTokenSnapshot(row.token_address).catch(() => null);
  const graduated = snap?.venue === "graduated";

  /**
   * These rows are a filter verdict from minutes ago, and a curve can be
   * emptied in that time — FIAT and CMC turned up here with 9 and 6 buyers
   * while sitting back at their phantom reserve, every token unsold. Such a
   * curve still quotes and still passes `tradeable`, so it reads as live.
   *
   * Re-applying the sniper's own liquidity floor is the honest test: if it
   * would not pass the filter now, it is not a candidate now. Only meaningful
   * on ETH-quoted curves, since the floor is denominated in ETH.
   */
  const floor = loadSniperConfig().minLiquidityEth ?? 0;
  const drained =
    !!snap &&
    !graduated &&
    snap.quoteIsNative &&
    snap.graduation.currentQuote < floor;

  // A snapshot we could not read is not evidence the curve is gone, so fall
  // back to what was recorded rather than declaring it dead.
  const actionable = snap ? snap.tradeable && !drained : false;

  const notes: string[] = [];
  if (drained) notes.push("liquidity has drained below the filter floor since it passed");
  if (blockedByQuote) {
    notes.push(`passes every filter but pays in ${row.quote_symbol ?? "a non-ETH quote"}, which the bot cannot buy yet`);
  }
  if (graduated) notes.push("has since graduated — the curve no longer sells");
  else if (snap && !snap.tradeable && snap.reason) notes.push(snap.reason);
  if (otherBuys >= 8) notes.push(`${otherBuys} other buyers — the top band (5.65% graduate)`);
  else if (otherBuys > 0) notes.push(`${otherBuys} other buyers`);
  else notes.push("no other buyers yet — the weakest band (0.11% graduate)");

  return {
    token: row.token_address,
    symbol: snap?.symbol ?? row.token_symbol ?? "???",
    logo: snap?.logo || row.logo || "",
    quoteSymbol: snap?.quoteSymbol ?? row.quote_symbol ?? "ETH",
    kind: graduated ? "graduated" : "curve",
    ts: row.ts,
    ageMinutes: minutesSince(row.ts),
    otherBuys,
    liquidity: snap?.graduation.currentQuote ?? row.liquidity ?? 0,
    gradPct: snap?.graduation.progressPct ?? row.grad_pct ?? 0,
    blockedByQuote,
    priceQuote: snap?.price.priceQuote ?? 0,
    mult: null,
    actionable,
    note: notes.join(" · "),
  };
}

/**
 * Graduated tokens, as a watchlist.
 *
 * Deliberately not ranked as buys. Replaying every graduation in the study
 * window put the median at -32% an hour later and -59% after twelve, and only
 * about 15% trade at all — so the honest thing to show is what each one has
 * actually done since, and let that speak.
 */
function graduatedWatchlist(hours: number): Suggestion[] {
  return recentGraduations(24)
    .filter((g) => minutesSince(g.ts) <= hours * 60)
    .map((g) => {
      // last_mult only moves when the stats sweep sees real swaps, so it sits
      // at its opening 1.0 for a token that has never traded. Reporting that
      // as "+0%" would imply a flat market rather than an empty one — and an
      // empty one is the common case, since only ~15% of graduations trade.
      const traded = (g.txs ?? 0) > 0;
      const mult = traded ? g.last_mult : null;
      const move =
        mult == null
          ? "no trades since it migrated"
          : `${mult >= 1 ? "+" : ""}${((mult - 1) * 100).toFixed(0)}% since open`;
      return {
        token: g.token_address,
        symbol: g.token_symbol ?? "???",
        logo: g.logo ?? "",
        quoteSymbol: g.quote_symbol ?? "ETH",
        kind: "graduated" as const,
        ts: g.ts,
        ageMinutes: minutesSince(g.ts),
        otherBuys: 0,
        liquidity: g.mcap ?? 0,
        gradPct: 100,
        blockedByQuote: false,
        priceQuote: 0,
        mult,
        actionable: false,
        note: `${move}${g.txs ? ` · ${g.txs} trades` : ""}`,
      };
    })
    .sort((a, b) => a.ageMinutes - b.ageMinutes)
    .slice(0, 12);
}

export async function getSuggestions(windowMinutes = 45): Promise<SuggestionSet> {
  const cached = gc.__ponsSuggestions;
  if (cached && cached.window === windowMinutes && Date.now() - cached.at < TTL_MS) {
    return cached.value;
  }

  const rows = approvedCandidates(windowMinutes);
  const enriched = await Promise.all(rows.map(enrich));

  const value: SuggestionSet = {
    preGraduation: enriched
      // A curve that graduated while sitting in the list is no longer a buy.
      .filter((s) => s.kind === "curve")
      // Still shown, but never above something you could actually act on.
      .sort(
        (a, b) =>
          Number(b.actionable) - Number(a.actionable) ||
          b.otherBuys - a.otherBuys ||
          a.ageMinutes - b.ageMinutes,
      ),
    postGraduation: graduatedWatchlist(12),
    windowMinutes,
    caveat:
      "These are filter passes, not predictions. Replayed over 114,544 launches, " +
      "automatic sniping lost money on every exit rule tested, and the median " +
      "graduated token is down 32% an hour later. Treat this as a shortlist to " +
      "look at, not a signal to act on.",
    generatedAt: new Date().toISOString(),
  };

  gc.__ponsSuggestions = { at: Date.now(), window: windowMinutes, value };
  return value;
}
