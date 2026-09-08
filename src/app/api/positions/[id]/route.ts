import { json, errorJson, requireAuth, refuseInPublicMode } from "@/lib/api";
import { getPosition, updatePosition } from "@/lib/db/positions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stop monitoring a position without selling (tokens stay in the bot wallet). */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  // Not on a public instance: this route is about the operator's own bot.
  const gone = refuseInPublicMode();
  if (gone) return gone;

  const unauth = requireAuth(req);
  if (unauth) return unauth;

  const { id } = await ctx.params;
  const row = getPosition(id);
  if (!row) return errorJson("position not found", 404);
  if (row.status !== "open") {
    return errorJson(`cannot cancel a ${row.status} position`, 409);
  }
  updatePosition(id, { status: "cancelled", close_reason: "manual" });
  return json({ ok: true, id, status: "cancelled" });
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  // Not on a public instance: this route is about the operator's own bot.
  const gone = refuseInPublicMode();
  if (gone) return gone;

  const { id } = await ctx.params;
  const row = getPosition(id);
  if (!row) return errorJson("position not found", 404);
  return json({ position: row });
}
