import { json, errorJson, requireAuth } from "@/lib/api";
import { activeDrafter, heuristicDrafter, claudeDrafter, type SourceMaterial } from "@/lib/launch/draft";
import {
  adviseLaunch,
  tickerHistory,
  insightsAvailable,
  LAUNCH_DEFAULTS,
  BASELINE_GRADUATION_PCT,
} from "@/lib/launch/insights";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return json({
    defaults: LAUNCH_DEFAULTS,
    baselineGraduationPct: BASELINE_GRADUATION_PCT,
    insights: insightsAvailable(),
    drafter: activeDrafter().kind,
    claudeReady: claudeDrafter.available(),
  });
}

/**
 * Draft a launch from source material, and check it against our own history.
 *
 * Reads only — this never deploys anything. Deployment stays a deliberate act
 * on pons with the operator's own wallet.
 */
export async function POST(req: Request) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  const body = (await req.json().catch(() => null)) as
    | (SourceMaterial & { symbol?: string; name?: string; creatorTaxBps?: number; quoteIsNative?: boolean })
    | null;
  if (!body || typeof body.text !== "string" || !body.text.trim()) {
    return errorJson("Paste a tweet or some text to work from.", 400);
  }

  // An explicit ticker means the user is editing, not asking for a draft.
  const editing = typeof body.symbol === "string" && body.symbol.trim().length > 0;
  let draft;
  if (editing) {
    draft = {
      name: String(body.name ?? "").slice(0, 32),
      symbol: String(body.symbol).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10),
      description: String(body.text).slice(0, 200),
      imageUrl: body.imageUrl,
      sourceUrl: body.sourceUrl,
      by: "heuristic" as const,
      alternatives: [] as string[],
    };
  } else {
    const drafter = activeDrafter();
    try {
      draft = await drafter.draft(body);
    } catch (e) {
      // A model failure must not stop the composer; fall back and say so.
      draft = await heuristicDrafter.draft(body);
      draft.description = draft.description || String(e).slice(0, 120);
    }
  }

  const creatorTaxBps = Number.isFinite(body.creatorTaxBps)
    ? Number(body.creatorTaxBps)
    : LAUNCH_DEFAULTS.creatorTaxBps;
  const quoteIsNative = body.quoteIsNative === true;

  const advice = adviseLaunch({
    symbol: draft.symbol,
    name: draft.name,
    creatorTaxBps,
    quoteIsNative,
    description: draft.description,
  });

  const history = tickerHistory(draft.symbol);
  const altHistory = (draft.alternatives ?? []).map((a) => tickerHistory(a));

  return json({
    draft,
    advice,
    history,
    altHistory,
    creatorTaxBps,
    quoteIsNative,
    baselineGraduationPct: BASELINE_GRADUATION_PCT,
  });
}
