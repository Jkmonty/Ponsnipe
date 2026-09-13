import { json, errorJson } from "@/lib/api";
import { loadTargets } from "@/lib/targets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The stocks to shoot at. The logic lives in lib/targets so a page can call it too. */
export async function GET() {
  try {
    return json({ targets: await loadTargets() });
  } catch (err) {
    return errorJson(err instanceof Error ? err.message : "could not load targets", 502);
  }
}
