import { json, refuseInPublicMode } from "@/lib/api";
import { monitorStatus } from "@/lib/engine/monitor";
import { db } from "@/lib/db/index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Not on a public instance: this route is about the operator's own bot.
  const gone = refuseInPublicMode();
  if (gone) return gone;

  const status = monitorStatus();
  const recentLog = db()
    .prepare(`SELECT ts, level, position_id, message FROM engine_log ORDER BY id DESC LIMIT 30`)
    .all();
  return json({ status, recentLog });
}
