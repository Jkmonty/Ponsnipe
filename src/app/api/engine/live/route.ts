import { z } from "zod";
import { json, errorJson, requireAuth } from "@/lib/api";
import { isLive, setLive } from "@/lib/engine/liveState";
import { hasBotWallet } from "@/lib/wallet/botWallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ live: z.boolean() });

export async function GET() {
  return json({ live: isLive() });
}

/** Flip live trading on/off without editing .env or restarting. */
export async function POST(req: Request) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorJson("body must be { live: boolean }");

  if (parsed.data.live && !hasBotWallet()) {
    return errorJson("Create a bot wallet before enabling live trading.", 409);
  }
  setLive(parsed.data.live);
  return json({ live: parsed.data.live });
}
