import { json } from "@/lib/api";
import { readFeed, DEFAULT_FILTERS, type FeedFilters } from "@/lib/feed/query";
import { feedStatus } from "@/lib/feed/market";
import { readGmgnFeed, GMGN_DEFAULTS, type GmgnFilters } from "@/lib/feed/gmgnQuery";
import { gmgnStatus } from "@/lib/feed/gmgn";

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

  /*
   * GMGN is the default source because it covers every launchpad on the chain;
   * our own index only sees pons curves, which measured as a minority of what
   * launches. `source=chain` forces the on-chain index, and it is also what is
   * served when no GMGN key is configured.
   */
  const gm = gmgnStatus();
  const wantChain = q.get("source") === "chain";
  if (!wantChain && gm.running) {
    const f: GmgnFilters = {
      minMcapUsd: num(q.get("minMcap"), GMGN_DEFAULTS.minMcapUsd),
      minVolumeUsd: num(q.get("minVolume"), GMGN_DEFAULTS.minVolumeUsd),
      minLiquidityUsd: num(q.get("minLiquidity"), GMGN_DEFAULTS.minLiquidityUsd),
      minHolders: num(q.get("minHolders"), GMGN_DEFAULTS.minHolders),
      maxAgeMin: Math.min(180, Math.max(5, num(q.get("maxAge"), GMGN_DEFAULTS.maxAgeMin) ?? 180)),
      hideHoneypots: q.get("honeypots") !== "1",
      maxDevHold: num(q.get("maxDevHold"), GMGN_DEFAULTS.maxDevHold),
      tradeableOnly: q.get("tradeable") === "1",
      launchpad: q.get("launchpad") || null,
      limit: Math.min(200, Math.max(1, num(q.get("limit"), GMGN_DEFAULTS.limit) ?? 60)),
    };
    const { rows, total, launchpads } = await readGmgnFeed(f);
    return json({
      source: "gmgn",
      rows,
      total,
      launchpads,
      filters: f,
      defaults: GMGN_DEFAULTS,
      status: { ...gm, chain: feedStatus() },
    });
  }

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

  const { rows, ethUsd, total, unpriced } = await readFeed(filters);
  return json({
    source: "chain",
    rows,
    ethUsd,
    total,
    unpriced,
    filters,
    defaults: DEFAULT_FILTERS,
    status: { ...feedStatus(), gmgn: gm },
  });
}
