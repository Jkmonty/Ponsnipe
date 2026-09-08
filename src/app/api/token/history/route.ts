import { isAddress } from "viem";
import { json, errorJson } from "@/lib/api";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Seconds per bucket in each table. Must match market.ts. */
const RES = { "5s": 5, "1m": 60 } as const;
type Res = keyof typeof RES;

/**
 * Price history for one coin, at whichever resolution the window needs.
 *
 * Two tables back this: five-second closes for the last two hours, and minute
 * closes for the last twelve. The caller asks for a span in minutes and gets
 * the finer of the two that can cover it, because for most of these coins the
 * whole story happens inside ten minutes and minute bars would draw it as
 * three dots.
 *
 * Everything here is already on disk from the feed sweep. No external data
 * source, no per-request chain calls, nothing metered.
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const address = u.searchParams.get("address")?.trim() ?? "";
  const minutes = Math.max(1, Math.min(720, Number(u.searchParams.get("minutes")) || 15));
  if (!isAddress(address)) return errorJson("invalid token address");

  try {
    const row = db()
      .prepare(`SELECT curve, created_at FROM feed_tokens WHERE token = ? COLLATE NOCASE`)
      .get(address) as { curve: string; created_at: string } | undefined;
    // Not an error: a coin older than the feed window is simply not indexed
    // here, and the panel should say "no history" rather than "request failed".
    if (!row) return json({ res: "5s", step: RES["5s"], points: [], indexed: false });

    // Ticks only reach back two hours; past that the minute table is the only
    // one with anything in it.
    const res: Res = minutes <= 120 ? "5s" : "1m";
    const table = res === "5s" ? "feed_ticks" : "feed_prices";
    const step = RES[res];
    const now = Math.floor(Date.now() / (step * 1000));
    const from = now - Math.ceil((minutes * 60) / step);

    const hist = db()
      .prepare(
        `SELECT bucket, price FROM ${table}
          WHERE curve = ? AND bucket > ? ORDER BY bucket`,
      )
      .all(row.curve, from) as { bucket: number; price: number }[];

    /*
     * Carried across quiet buckets, for the same reason the sparkline carries
     * its own: a five-second window with no trade is not a price of zero, it
     * is the price from before. Leading buckets before the first trade stay
     * absent rather than being back-filled with a price that did not exist.
     */
    const byBucket = new Map(hist.map((h) => [h.bucket, h.price]));
    const points: { t: number; p: number }[] = [];
    let last = 0;
    for (let b = Math.max(from + 1, hist[0]?.bucket ?? from + 1); b <= now; b++) {
      const v = byBucket.get(b);
      if (v != null && v > 0) last = v;
      if (last > 0) points.push({ t: b * step * 1000, p: last });
    }

    // Trade counts come from the minute table whatever the price resolution:
    // it is the only place buys and sells are split.
    const volFrom = Math.floor(Date.now() / 60_000) - minutes;
    const vol = db()
      .prepare(
        `SELECT bucket, quote, buys, sells FROM feed_volume
          WHERE curve = ? AND bucket > ? ORDER BY bucket`,
      )
      .all(row.curve, volFrom) as
      { bucket: number; quote: number; buys: number; sells: number }[];

    return json({
      res,
      step,
      indexed: true,
      launchedAt: row.created_at,
      points,
      vol: vol.map((v) => ({ t: v.bucket * 60_000, q: v.quote, b: v.buys, s: v.sells })),
    });
  } catch (err) {
    return errorJson(err instanceof Error ? err.message : "failed to load history", 502);
  }
}
