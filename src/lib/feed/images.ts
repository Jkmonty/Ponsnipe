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
const GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
];

const MAX_BYTES = 3 * 1024 * 1024;
const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 800;

export interface CachedImage {
  at: number;
  type: string;
  body: ArrayBuffer;
}

const gc = globalThis as typeof globalThis & {
  __ponsImgCache?: Map<string, CachedImage>;
  __ponsImgInFlight?: Set<string>;
};
function cache(): Map<string, CachedImage> {
  gc.__ponsImgCache ??= new Map();
  return gc.__ponsImgCache;
}
function inFlight(): Set<string> {
  gc.__ponsImgInFlight ??= new Set();
  return gc.__ponsImgInFlight;
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

/** ipfs:// and bare CIDs become gateway URLs; http(s) passes through. */
export function candidates(raw: string): string[] {
  const t = raw.trim();
  if (/^https?:\/\//i.test(t)) return [t];
  const cid = t.startsWith("ipfs://")
    ? t.slice("ipfs://".length).replace(/^ipfs\//, "")
    : /^(baf[0-9a-z]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{44})/.test(t)
      ? t
      : "";
  return cid ? GATEWAYS.map((g) => g + cid) : [];
}

export function cached(raw: string): CachedImage | null {
  const hit = cache().get(raw);
  return hit && Date.now() - hit.at < TTL_MS ? hit : null;
}

/** Fetch and cache one logo. Resolves to null when nothing serves it. */
export async function resolveImage(raw: string): Promise<CachedImage | null> {
  const hit = cached(raw);
  if (hit) return hit;
  if (inFlight().has(raw)) return null;
  inFlight().add(raw);

  try {
    for (const url of candidates(raw)) {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        continue;
      }
      if (!safeHost(target)) continue;
      try {
        const r = await fetch(target, {
          signal: AbortSignal.timeout(8000),
          headers: { accept: "image/*" },
          redirect: "follow",
        });
        if (!r.ok) continue;
        const type = r.headers.get("content-type") ?? "";
        // A gateway answering with an HTML error page is a failure, not an
        // image, and would render as a broken tile if passed through.
        if (!type.startsWith("image/")) continue;
        if (Number(r.headers.get("content-length") ?? 0) > MAX_BYTES) continue;
        const body = await r.arrayBuffer();
        if (body.byteLength > MAX_BYTES) continue;

        const c = cache();
        if (c.size >= MAX_ENTRIES) c.delete(c.keys().next().value as string);
        const entry: CachedImage = { at: Date.now(), type, body };
        c.set(raw, entry);
        return entry;
      } catch {
        /* try the next gateway */
      }
    }
    return null;
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
