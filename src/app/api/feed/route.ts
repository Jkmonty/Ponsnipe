import { json } from "@/lib/api";
import { readFeed, DEFAULT_FILTERS, type FeedFilters } from "@/lib/feed/query";
import { feedStatus } from "@/lib/feed/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A filter left out of the query keeps its default; `off` disables it. */
function num(v: string | null, dflt: number | null): number | null {
  if (v === null) return dflt;
  if (v === "" || v === "off") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const filters: FeedFilters = {
    minMcapUsd: num(q.get("minMcap"), DEFAULT_FILTERS.minMcapUsd),
    minVolumeUsd: num(q.get("minVolume"), DEFAULT_FILTERS.minVolumeUsd),
    minLiquidityUsd: num(q.get("minLiquidity"), DEFAULT_FILTERS.minLiquidityUsd),
    minTrades: num(q.get("minTrades"), DEFAULT_FILTERS.minTrades),
    volumeWindowMin: Math.min(180, Math.max(1, num(q.get("window"), DEFAULT_FILTERS.volumeWindowMin) ?? 60)),
    maxAgeMin: Math.min(180, Math.max(5, num(q.get("maxAge"), DEFAULT_FILTERS.maxAgeMin) ?? 180)),
    includeUnpriced: q.get("unpriced") === "1",
    quote: (["all", "eth", "stable"] as const).includes(q.get("quote") as never)
      ? (q.get("quote") as "all" | "eth" | "stable")
      : "all",
    limit: Math.min(200, Math.max(1, num(q.get("limit"), DEFAULT_FILTERS.limit) ?? 60)),
  };

  const { rows, ethUsd, total } = await readFeed(filters);
  return json({ rows, ethUsd, total, filters, defaults: DEFAULT_FILTERS, status: feedStatus() });
}
