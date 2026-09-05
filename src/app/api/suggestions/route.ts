import { json } from "@/lib/api";
import { getSuggestions } from "@/lib/sniper/suggestions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only: what the sniper would have bought. Signs nothing, spends nothing. */
export async function GET(req: Request) {
  const raw = Number(new URL(req.url).searchParams.get("windowMinutes") ?? 45);
  const windowMinutes = Number.isFinite(raw) ? Math.min(1440, Math.max(5, raw)) : 45;
  return json(await getSuggestions(windowMinutes));
}
