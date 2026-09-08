import { isAddress } from "viem";
import { json, errorJson } from "@/lib/api";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Steps the chart may ask for, in milliseconds. Anything else becomes 1s.
 *
 * Every one is a whole multiple of the bucket size of the table that serves
 * it. 250ms was tried and dropped: against 100ms buckets it makes candles of
 * two and three buckets alternately, so neighbouring candles would cover
 * different amounts of time while claiming to be the same width.
 */
const STEPS = [200, 1_000, 5_000, 30_000, 60_000] as const;

/**
 * The three tables prices live in, coarsest last, with the bucket size each
 * uses. A step is served by the finest one that both divides it and reaches
 * back far enough — see `source` below. These must match market.ts.
 */
const SOURCES = [
  { table: "feed_subticks", unit: 100, keepMs: 10 * 60_000 },
  { table: "feed_ticks", unit: 1_000, keepMs: 60 * 60_000 },
  { table: "feed_prices", unit: 60_000, keepMs: 12 * 60 * 60_000 },
] as const;

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/**
 * Candles for one coin, at the step the chart asks for.
 *
 * Everything here is already on disk from the feed sweep, which records the
 * price after every individual trade. No external data source, no per-request
 * chain call, nothing metered.
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const address = u.searchParams.get("address")?.trim() ?? "";
  /*
   * Fractions allowed. The sub-second step asks for half a minute, and a floor
   * of one silently doubled its window — 300 candles across a 340px chart,
   * each a pixel wide, which is a comb rather than a chart.
   */
  const minutes = Math.max(0.05, Math.min(720, Number(u.searchParams.get("minutes")) || 15));
  const asked = Number(u.searchParams.get("step")) || 1_000;
  const step = (STEPS as readonly number[]).includes(asked) ? asked : 1_000;
  if (!isAddress(address)) return errorJson("invalid token address");

  try {
    const row = db()
      .prepare(`SELECT curve, created_at FROM feed_tokens WHERE token = ? COLLATE NOCASE`)
      .get(address) as { curve: string; created_at: string } | undefined;
    // Not an error: a coin older than the feed window is simply not indexed
    // here, and the panel should say "no history" rather than "request failed".
    if (!row) return json({ step, indexed: false, candles: [], vol: [] });

    /*
     * The finest table that can answer, which is not always the finest table.
     * Sub-second buckets only reach back ten minutes, so a thirty-second step
     * over an hour has to come from the second-resolution table even though
     * the sub-second one is finer — asking the wrong one would silently return
     * only the last ten minutes of a sixty-minute window.
     */
    const wantMs = minutes * 60_000;
    const src =
      SOURCES.find((s) => step >= s.unit && wantMs <= s.keepMs) ??
      SOURCES[SOURCES.length - 1];

    const now = Math.floor(Date.now() / src.unit);
    const from = now - Math.ceil(wantMs / src.unit);
    const hist = db()
      .prepare(
        `SELECT bucket, price, o, h, l FROM ${src.table}
          WHERE curve = ? AND bucket > ? ORDER BY bucket`,
      )
      .all(row.curve, from) as {
      bucket: number;
      price: number;
      o: number | null;
      h: number | null;
      l: number | null;
    }[];

    /*
     * Rolled up to the asked-for step. Open comes from the first row in the
     * group and close from the last, which is what makes this a candle rather
     * than a smoothed line — an average would hide the wick, and the wick is
     * the part a sniper is reading.
     *
     * Rows written by the pricing pass rather than by a trade have no range to
     * report, so their open, high and low fall back to the close and the
     * candle is flat. That is the truth about them: nothing traded.
     */
    /*
     * The last price before the window opened, so a coin that traded a minute
     * ago still draws.
     *
     * Carry-forward can only carry something it has. With a thirty-second
     * window and no trade inside it there was nothing to start from, so a coin
     * with nine hundred trades reported "not enough trades yet" — which reads
     * as broken rather than as quiet. Worse right after a deploy, when the
     * sub-second table is empty for everybody and every coin said it.
     *
     * Looked for in the coarser tables too, because those go back further: the
     * point is to find any price at all that predates the window.
     */
    let seed = 0;
    const windowFrom = Date.now() - wantMs;
    if (!hist.length || hist[0].bucket * src.unit > windowFrom) {
      for (const alt of SOURCES) {
        const before = db()
          .prepare(
            `SELECT price FROM ${alt.table}
              WHERE curve = ? AND bucket <= ? ORDER BY bucket DESC LIMIT 1`,
          )
          .get(row.curve, Math.floor(windowFrom / alt.unit)) as
          | { price: number }
          | undefined;
        if (before?.price) {
          seed = before.price;
          break;
        }
      }
    }

    /*
     * Which candle a stored bucket belongs to, in candle numbers since the
     * epoch — the same unit the fill loop below counts in.
     *
     * Converting through milliseconds rather than dividing bucket by a ratio
     * is not fussiness: the two are in different units otherwise, and the loop
     * that fills gaps between them then runs from one to the other. With a
     * 200ms step over 100ms buckets that was a billion iterations and a dead
     * server, which is how this comment came to be written.
     */
    const key = (bucket: number) => Math.floor((bucket * src.unit) / step);
    const groups = new Map<number, Candle>();
    for (const r of hist) {
      const k = key(r.bucket);
      const o = r.o ?? r.price;
      const h = r.h ?? r.price;
      const l = r.l ?? r.price;
      const at = groups.get(k);
      if (!at) {
        groups.set(k, { t: k * step, o, h, l, c: r.price });
        continue;
      }
      if (h > at.h) at.h = h;
      if (l < at.l) at.l = l;
      at.c = r.price;
    }

    /*
     * Gaps filled with a flat candle at the last close, for the same reason
     * the sparkline carries its line: a step with no trade is not a price of
     * zero, it is the price from before, and it has no range. Leading steps
     * before the first trade stay absent rather than being back-filled with a
     * price that did not exist yet.
     */
    const last = Math.floor(Date.now() / step);
    // Never further back than the window asked for, whatever is in the table.
    // A cap belongs here rather than in a comment: it is the difference
    // between a wrong answer and an unbounded loop.
    const span = Math.ceil(wantMs / step) + 2;
    // With a seed there is a price for the whole window, so draw the whole
    // window. Without one, start where the data does.
    const first = seed
      ? last - span
      : Math.max(last - span, hist.length ? key(hist[0].bucket) : last);
    const candles: Candle[] = [];
    let carried = seed;
    for (let b = first; b <= last; b++) {
      const g = groups.get(b);
      if (g) {
        candles.push(g);
        carried = g.c;
      } else if (carried > 0) {
        candles.push({ t: b * step, o: carried, h: carried, l: carried, c: carried });
      }
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
      /*
       * When the price last actually moved, as opposed to when the line last
       * got a point. Everything after this is carried forward, so without it a
       * quiet coin and a broken chart draw exactly the same picture.
       */
      lastAt: hist.length ? hist[hist.length - 1].bucket * src.unit : null,
      candles,
      vol: vol.map((v) => ({ t: v.bucket * 60_000, q: v.quote, b: v.buys, s: v.sells })),
    });
  } catch (err) {
    return errorJson(err instanceof Error ? err.message : "failed to load history", 502);
  }
}
