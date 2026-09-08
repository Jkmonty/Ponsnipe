import { isAddress } from "viem";
import { json, errorJson } from "@/lib/api";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Steps the chart may ask for, in seconds. Anything else is rounded to one. */
const STEPS = [1, 5, 30, 60] as const;
/** How far back the tick table reaches. Must match TICK_KEEP_MINUTES. */
const TICK_MINUTES = 60;

/**
 * Price history for one coin, at the step the chart asks for.
 *
 * Two tables back this: one-second closes for the last hour, and minute closes
 * for the last twelve. A one-second step reads the first straight; five and
 * thirty aggregate it here rather than in another table; a minute step past
 * the tick window falls through to the minute table.
 *
 * Everything is already on disk from the feed sweep. No external data source,
 * no per-request chain call, nothing metered.
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const address = u.searchParams.get("address")?.trim() ?? "";
  const minutes = Math.max(1, Math.min(720, Number(u.searchParams.get("minutes")) || 15));
  const asked = Number(u.searchParams.get("step")) || 5;
  const step = (STEPS as readonly number[]).includes(asked) ? asked : 5;
  if (!isAddress(address)) return errorJson("invalid token address");

  try {
    const row = db()
      .prepare(`SELECT curve, created_at FROM feed_tokens WHERE token = ? COLLATE NOCASE`)
      .get(address) as { curve: string; created_at: string } | undefined;
    // Not an error: a coin older than the feed window is simply not indexed
    // here, and the panel should say "no history" rather than "request failed".
    if (!row) return json({ step, indexed: false, points: [], vol: [] });

    /*
     * Which table can answer this. Ticks are the only source fine enough for
     * anything under a minute, but they only reach back an hour — so a minute
     * step over a longer window has to come from feed_prices, which is the
     * only one that goes back twelve.
     */
    const fromTicks = step < 60 || minutes <= TICK_MINUTES;
    const src = fromTicks
      ? { table: "feed_ticks", unit: 1 }
      : { table: "feed_prices", unit: 60 };

    const now = Math.floor(Date.now() / (src.unit * 1000));
    const from = now - Math.ceil((minutes * 60) / src.unit);
    const hist = db()
      .prepare(
        `SELECT bucket, price FROM ${src.table}
          WHERE curve = ? AND bucket > ? ORDER BY bucket`,
      )
      .all(row.curve, from) as { bucket: number; price: number }[];

    /*
     * Down to the asked-for step, keeping the last price in each — a close is
     * what a bar is made of, and taking the first or an average would smooth
     * away the spike that a sniper is watching for.
     */
    const per = Math.max(1, Math.round(step / src.unit));
    const closes = new Map<number, number>();
    for (const h of hist) closes.set(Math.floor(h.bucket / per), h.price);

    /*
     * Carried across quiet steps, for the same reason the sparkline carries
     * its own: a second with no trade is not a price of zero, it is the price
     * from before. Leading steps before the first trade stay absent rather
     * than being back-filled with a price that did not exist.
     */
    const last = Math.floor(now / per);
    const first = hist.length ? Math.floor(hist[0].bucket / per) : last;
    const points: { t: number; p: number }[] = [];
    let carried = 0;
    for (let b = first; b <= last; b++) {
      const v = closes.get(b);
      if (v != null && v > 0) carried = v;
      if (carried > 0) points.push({ t: b * step * 1000, p: carried });
    }

    // Trade counts come from the minute table whatever the price step: it is
    // the only place buys and sells are split.
    const volFrom = Math.floor(Date.now() / 60_000) - minutes;
    const vol = db()
      .prepare(
        `SELECT bucket, quote, buys, sells FROM feed_volume
          WHERE curve = ? AND bucket > ? ORDER BY bucket`,
      )
      .all(row.curve, volFrom) as {
      bucket: number;
      quote: number;
      buys: number;
      sells: number;
    }[];

    return json({
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
