import { json, errorJson } from "@/lib/api";
import { db } from "@/lib/db";
import { accruedPct, multipliersFor } from "@/lib/feed/multipliers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What each stock quote asset has paid, and what it is about to pay.
 *
 * Forty-two percent of live pons launches are priced against tokenised
 * equities, and those tokens pass dividends through as a multiplier rather
 * than as a payment — so a trader holding one of those positions is collecting
 * dividend equivalents and has no way to know it. This is that, made visible.
 *
 * The pending fields are the interesting half: the contract publishes the next
 * adjustment and the moment it takes effect, so a dividend is readable before
 * it lands rather than only afterwards.
 *
 * Reads the quote assets the feed is actually using rather than a hardcoded
 * list, so a ticker that starts being launched against appears on its own.
 */
export async function GET() {
  try {
    const rows = db()
      .prepare(
        `SELECT quote_symbol AS symbol, quote_token AS address, COUNT(*) AS launches
           FROM feed_tokens
          WHERE quote_is_native = 0 AND quote_token IS NOT NULL AND quote_symbol IS NOT NULL
          GROUP BY quote_token
          ORDER BY launches DESC
          LIMIT 40`,
      )
      .all() as { symbol: string; address: string; launches: number }[];

    const mult = await multipliersFor(rows);
    const assets = rows
      .map((r) => {
        const m = mult.get(r.symbol.toUpperCase());
        if (!m?.scaled) return null;
        return {
          symbol: r.symbol,
          launches: r.launches,
          multiplier: m.now,
          /** Dividends since the share was tokenised, as a percentage. */
          accruedPct: accruedPct(m),
          pending: m.next == null ? null : { multiplier: m.next, effectiveAt: m.at },
        };
      })
      .filter(Boolean);

    return json({ assets });
  } catch (err) {
    return errorJson(err instanceof Error ? err.message : "failed to read multipliers", 502);
  }
}
