import { json } from "@/lib/api";
import { readFeed, DEFAULT_FILTERS, type FeedFilters } from "@/lib/feed/query";
import { feedStatus } from "@/lib/feed/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function num(v: string | null, dflt: number): number {
  if (v === null || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** New pons pairs, newest first. One source, no filters. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const filters: FeedFilters = {
    maxAgeMin: Math.min(180, Math.max(5, num(q.get("maxAge"), DEFAULT_FILTERS.maxAgeMin))),
    limit: Math.min(400, Math.max(1, num(q.get("limit"), DEFAULT_FILTERS.limit))),
  };
  const { rows, total, ethUsd, unpriced } = await readFeed(filters);
  return json({ rows, total, ethUsd, unpriced, status: feedStatus() });
}
