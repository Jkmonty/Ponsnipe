import { json, errorJson } from "@/lib/api";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rounds for the paper sniper: real launches, replayed.
 *
 * The point is not a game about shooting things. It is that a trader cannot be
 * told why the filters matter — they have to watch themselves lose on eight
 * launches in a row and then see which rule would have stopped five of them.
 * That needs real coins with real outcomes, which is a thing only this index
 * can serve, because it holds what actually happened to every launch.
 *
 * Replayed rather than live, so the answer is immediate. A launch sniped now
 * would take five minutes to score, and nobody plays a game with a five-minute
 * feedback loop.
 *
 * What a round shows is strictly what was knowable at the moment of launch:
 * the name, the artwork, what it is priced in, whatever link the deployer put
 * on chain, and the deployer's own history. Current holders or volume would
 * leak the outcome and turn a judgement into a reading-comprehension test.
 */
const WINDOW_MIN = 8;
const WINDOW_MAX = 55;

interface Round {
  symbol: string;
  name: string;
  logo: string;
  quoteSymbol: string;
  socials: string;
  description: string;
  devLaunches: number;
  devGraduated: number;
  devTraded: number;
  outcome: {
    everTraded: boolean;
    /** Multiple of the launch price at its highest. 1 means it never moved. */
    peak: number;
    /** Multiple at the last price we hold — what holding would have got you. */
    held: number;
    trades: number;
  };
}

export async function GET(req: Request) {
  const want = Math.max(1, Math.min(20, Number(new URL(req.url).searchParams.get("n")) || 8));
  try {
    /*
     * ISO bounds computed here rather than with datetime('now').
     *
     * created_at is written as an ISO string with a T and a Z; SQLite's
     * datetime() returns a space-separated one with neither. Comparing them is
     * a string comparison where 'T' sorts after ' ', so every such filter
     * silently matches nothing — which it did, and looked like an empty table.
     */
    const from = new Date(Date.now() - WINDOW_MAX * 60_000).toISOString();
    const to = new Date(Date.now() - WINDOW_MIN * 60_000).toISOString();

    const rows = db()
      .prepare(
        `SELECT t.curve, t.symbol, t.name, t.logo, t.quote_symbol, t.quote_is_native,
                t.socials, t.description, t.deployer,
                (SELECT COUNT(*) FROM feed_ticks k WHERE k.curve = t.curve) AS ticks,
                (SELECT MIN(bucket) FROM feed_ticks k WHERE k.curve = t.curve) AS firstBucket,
                (SELECT MAX(price) FROM feed_ticks k WHERE k.curve = t.curve) AS hi,
                (SELECT price FROM feed_ticks k WHERE k.curve = t.curve
                  ORDER BY bucket DESC LIMIT 1) AS lastPrice,
                (SELECT COALESCE(SUM(buys + sells),0) FROM feed_volume v WHERE v.curve = t.curve) AS trades
           FROM feed_tokens t
          WHERE t.created_at BETWEEN ? AND ?
            AND t.symbol IS NOT NULL
          ORDER BY RANDOM()
          LIMIT ?`,
      )
      .all(from, to, want * 3) as Record<string, unknown>[];

    const devs = db()
      .prepare(
        `SELECT deployer,
                COUNT(*) AS n,
                SUM(graduated) AS grad,
                SUM(CASE WHEN vv.curve IS NOT NULL THEN 1 ELSE 0 END) AS traded
           FROM feed_tokens t
           LEFT JOIN (SELECT DISTINCT curve FROM feed_volume) vv ON vv.curve = t.curve
          GROUP BY deployer`,
      )
      .all() as { deployer: string; n: number; grad: number; traded: number }[];
    const byDev = new Map(devs.map((d) => [String(d.deployer).toLowerCase(), d]));

    const rounds: Round[] = [];
    for (const r of rows) {
      if (rounds.length >= want) break;
      const ticks = Number(r.ticks ?? 0);
      // Needs a first price to buy at. One reading is not a price path.
      if (ticks < 2) continue;

      const first = db()
        .prepare(`SELECT price FROM feed_ticks WHERE curve = ? ORDER BY bucket LIMIT 1`)
        .get(String(r.curve)) as { price: number } | undefined;
      const open = first?.price ?? 0;
      if (!(open > 0)) continue;

      const d = byDev.get(String(r.deployer ?? "").toLowerCase());
      rounds.push({
        symbol: String(r.symbol ?? ""),
        name: String(r.name ?? ""),
        logo: String(r.logo ?? ""),
        quoteSymbol: r.quote_is_native === 1 ? "ETH" : String(r.quote_symbol ?? "?"),
        socials: String(r.socials ?? ""),
        description: String(r.description ?? ""),
        devLaunches: d?.n ?? 1,
        devGraduated: d?.grad ?? 0,
        devTraded: d?.traded ?? 0,
        outcome: {
          everTraded: Number(r.trades ?? 0) > 0,
          peak: Number(r.hi ?? open) / open,
          held: Number(r.lastPrice ?? open) / open,
          trades: Number(r.trades ?? 0),
        },
      });
    }

    return json({ rounds });
  } catch (err) {
    return errorJson(err instanceof Error ? err.message : "could not build a round", 502);
  }
}
