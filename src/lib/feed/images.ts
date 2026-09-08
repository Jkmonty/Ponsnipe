/**
 * Token artwork: resolving, caching, and warming.
 *
 * Shared by the proxy route and the launch sweep. The sweep matters as much as
 * the route: over half of these logos are ipfs:// and a public gateway takes
 * seconds on a first fetch, while a row at the top of a feed that turns over
 * every couple of seconds is only ever seconds old. Left to the browser, the
 * newest coins would never finish loading their image before scrolling away.
 * Fetching them the moment a launch is indexed means the picture is already in
 * hand by the time anyone looks at it.
 */
import sharp from "sharp";
/*
 * Gateways, measured on a cold CID rather than chosen by reputation:
 *
 *   ipfs.io            200 in 6.7s cold, and 12s on another CID
 *   dweb.link          200 in 15.3s cold, 2.6s warm
 *   nftstorage.link    200 in 15.4s cold, 3.1s warm
 *   4everland.io       200 in 15.0s cold
 *   gateway.pinata     429 — rate-limiting us
 *   cloudflare-ipfs    connection refused; the service was retired
 *
 * The old list was ipfs.io, then pinata, then cloudflare-ipfs: slow, then
 * rate-limited, then dead. Tried in series against an 8s budget, an ipfs://
 * logo usually ran out of time before any of them answered, which is why the
 * feed showed initials where a picture should be.
 */
const GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://nftstorage.link/ipfs/",
  "https://4everland.io/ipfs/",
];

/*
 * Cold fetches measured at 6-15s, warm ones at 2.6-3.1s, and which gateway is
 * quick varies by CID. Racing them costs the fastest one's latency instead of
 * the sum of every slow one ahead of it, so the budget below is per attempt
 * rather than per logo.
 */
const FETCH_TIMEOUT_MS = 15_000;

const MAX_BYTES = 3 * 1024 * 1024;

/**
 * What a logo is shrunk to before it is cached or served.
 *
 * The feed draws these at 38 CSS pixels. It was serving whatever the creator
 * uploaded — 400x400 and up, one of them 2.87MB — so a single page load pulled
 * 19.6MB of artwork to fill 53 thumbnails. That is the slowest thing on a page
 * whose entire pitch is being fast, and on a metered host it is also the whole
 * bandwidth bill.
 *
 * 96px covers a 2x display with room to spare. WebP because every browser that
 * can reach this app supports it, and it is a fraction of the equivalent PNG.
 */
const THUMB_PX = 96;
const THUMB_QUALITY = 80;

/**
 * Shrink one logo, or hand back the original if it cannot be read.
 *
 * Never throws. A logo sharp cannot decode is still a logo, and serving one
 * awkward image at full size beats a hole where a coin should be.
 */
async function shrink(
  body: ArrayBuffer,
  type: string,
): Promise<{ body: ArrayBuffer; type: string }> {
  try {
    const out = await sharp(Buffer.from(body), { animated: false })
      // EXIF orientation applied before the resize, or a rotated source comes
      // out sideways in a square crop.
      .rotate()
      .resize(THUMB_PX, THUMB_PX, { fit: "cover", position: "centre", withoutEnlargement: true })
      .webp({ quality: THUMB_QUALITY })
      .toBuffer();
    // A "shrink" that grew the file is not one: tiny icons and already-small
    // WebP can come back larger than they went in.
    if (out.byteLength >= body.byteLength) return { body, type };
    const copy = new ArrayBuffer(out.byteLength);
    new Uint8Array(copy).set(out);
    return { body: copy, type: "image/webp" };
  } catch {
    return { body, type };
  }
}
const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 800;

export interface CachedImage {
  at: number;
  type: string;
  body: ArrayBuffer;
}

const gc = globalThis as typeof globalThis & {
  __ponsImgCache?: Map<string, CachedImage>;
  __ponsImgPending?: Map<string, Promise<CachedImage | null>>;
};
function cache(): Map<string, CachedImage> {
  gc.__ponsImgCache ??= new Map();
  return gc.__ponsImgCache;
}
/**
 * The fetch itself, keyed by logo, so callers share one rather than racing.
 *
 * The key is __ponsImgPending, not the __ponsImgInFlight this replaced. These
 * singletons hang off globalThis so route modules share them, which means they
 * outlive a module reload: `??=` sees the old Set still sitting there, keeps
 * it, and every `.get` on it throws. Changing the shape needs a new name.
 *
 * This used to be a Set of keys, and a second caller was told "in flight" and
 * given nothing. That is precisely the newest rows: the sweep warms a logo the
 * moment it indexes the launch, the browser asks for it a second later, and
 * the route returned 404 while a fetch that would have succeeded was still in
 * the air. The row fell back to initials for a picture we were already
 * holding. Sharing the promise means the second caller waits for the first.
 */
function inFlight(): Map<string, Promise<CachedImage | null>> {
  gc.__ponsImgPending ??= new Map();
  return gc.__ponsImgPending;
}

/**
 * Only public hosts over http(s).
 *
 * These URLs come out of token contracts, which anyone can deploy with
 * anything inside, so without this the fetcher would follow whatever a
 * stranger wrote — including loopback and private-range addresses reachable
 * from this machine but not from the internet.
 */
function safeHost(u: URL): boolean {
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal")) return false;
  if (h.includes(":")) return false; // IPv6 literal, ::1 included
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a >= 224) return false;
  }
  return true;
}

/** A CID, wherever it is hiding: ipfs://, a bare CID, or a gateway URL path. */
function cidOf(t: string): string {
  if (t.startsWith("ipfs://")) return t.slice("ipfs://".length).replace(/^ipfs\//, "");
  if (/^(baf[0-9a-z]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{44})/.test(t)) return t;
  // A gateway URL is still a CID. Tokens often store the pinata one, and
  // pinata rate-limits us (429), so without this those logos had no second
  // chance at all — three of six unserved logos in a 40-row sample.
  const m = /\/ipfs\/(baf[0-9a-z]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{44})/.exec(t);
  return m ? m[1] : "";
}

/**
 * Every URL worth trying for one logo, best first.
 *
 * An http(s) URL is tried as written, since that is what the token asked for,
 * but when a CID can be recovered from it the gateways follow as fallbacks.
 */
export function candidates(raw: string): string[] {
  const t = raw.trim();
  const cid = cidOf(t);
  const urls = /^https?:\/\//i.test(t) ? [t] : [];
  if (cid) for (const g of GATEWAYS) if (!urls.includes(g + cid)) urls.push(g + cid);
  return urls;
}

export function cached(raw: string): CachedImage | null {
  const hit = cache().get(raw);
  return hit && Date.now() - hit.at < TTL_MS ? hit : null;
}

/** Fetch and cache one logo. Resolves to null when nothing serves it. */
export async function resolveImage(raw: string): Promise<CachedImage | null> {
  const hit = cached(raw);
  if (hit) return hit;
  const running = inFlight().get(raw);
  if (running) return running;
  const p = fetchImage(raw);
  inFlight().set(raw, p);
  return p;
}

async function fetchImage(raw: string): Promise<CachedImage | null> {
  try {
    const urls = candidates(raw).filter((u) => {
      try {
        return safeHost(new URL(u));
      } catch {
        return false;
      }
    });
    if (!urls.length) return null;

    // Race, do not queue. Which gateway is quick varies by CID, so the first
    // one to hand back an actual image wins and the rest are abandoned.
    const ctrl = new AbortController();
    const attempt = async (url: string): Promise<CachedImage> => {
      const r = await fetch(url, {
        signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
        headers: { accept: "image/*" },
        redirect: "follow",
      });
      if (!r.ok) throw new Error(String(r.status));
      const type = r.headers.get("content-type") ?? "";
      // A gateway answering with an HTML error page is a failure, not an
      // image, and would render as a broken tile if passed through.
      if (!type.startsWith("image/")) throw new Error("not an image");
      if (Number(r.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error("too big");
      const body = await r.arrayBuffer();
      if (body.byteLength > MAX_BYTES) throw new Error("too big");
      // Shrunk before it is cached rather than on the way out: the cache then
      // holds kilobytes per logo instead of megabytes, and the work happens
      // once per image instead of once per viewer.
      const small = await shrink(body, type);
      return { at: Date.now(), type: small.type, body: small.body };
    };

    let entry: CachedImage;
    try {
      entry = await Promise.any(urls.map(attempt));
    } catch {
      // Every gateway failed: AggregateError, nothing served this logo.
      return null;
    } finally {
      // Stop the losers downloading bytes nobody will look at.
      ctrl.abort();
    }

    const c = cache();
    if (c.size >= MAX_ENTRIES) c.delete(c.keys().next().value as string);
    c.set(raw, entry);
    return entry;
  } finally {
    inFlight().delete(raw);
  }
}

/** Fire-and-forget warm for freshly indexed launches. Never throws. */
export function warmImages(logos: (string | null | undefined)[]): void {
  for (const l of logos) {
    if (!l || l.length > 512 || cached(l)) continue;
    void resolveImage(l).catch(() => {});
  }
}
