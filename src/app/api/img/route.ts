import { NextResponse } from "next/server";
import { cached, resolveImage } from "@/lib/feed/images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves token artwork from the shared cache, fetching it if the launch sweep
 * has not warmed it yet. Resolution, gateway fallback and the private-address
 * guard all live in lib/feed/images.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("u") ?? "";
  if (!raw || raw.length > 512) return new NextResponse(null, { status: 400 });

  const hit = cached(raw) ?? (await resolveImage(raw));
  // 404 rather than a placeholder: the client falls back to the direct URL and
  // then to its initials tile, which it can do only if this says nothing.
  if (!hit) return new NextResponse(null, { status: 404 });

  return new NextResponse(hit.body, {
    headers: { "content-type": hit.type, "cache-control": "public, max-age=1800" },
  });
}
