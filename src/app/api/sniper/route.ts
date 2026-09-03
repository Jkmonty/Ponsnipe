import { json, errorJson, requireAuth } from "@/lib/api";
import {
  loadSniperConfig,
  saveSniperConfig,
  sniperConfigSchema,
  DEFAULT_CONFIG,
} from "@/lib/sniper/config";
import { sniperStatus } from "@/lib/sniper/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return json({ config: loadSniperConfig(), status: sniperStatus(), defaults: DEFAULT_CONFIG });
}

export async function POST(req: Request) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  const body = await req.json().catch(() => null);
  // Merge onto current config so the UI can send partial updates.
  const merged = { ...loadSniperConfig(), ...(body ?? {}) };
  const parsed = sniperConfigSchema.safeParse(merged);
  if (!parsed.success) {
    return errorJson(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  // The boot-time watcher (src/instrumentation.ts) reads the config fresh on
  // every launch, so a save takes effect immediately — no restart needed.
  saveSniperConfig(parsed.data);
  return json({ config: parsed.data, status: sniperStatus() });
}
