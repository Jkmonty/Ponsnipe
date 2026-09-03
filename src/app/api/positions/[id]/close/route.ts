import { json, errorJson, requireAuth } from "@/lib/api";
import { getPosition } from "@/lib/db/positions";
import { closePosition } from "@/lib/engine/executor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sell a position immediately at market. */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  const { id } = await ctx.params;
  const row = getPosition(id);
  if (!row) return errorJson("position not found", 404);
  if (row.status !== "open") {
    return errorJson(`position is ${row.status}`, 409);
  }

  const result = await closePosition(id, "manual");
  if (!result.ok) return errorJson(result.message, 502);
  return json({ ok: true, id, result: result.message, position: getPosition(id) });
}
