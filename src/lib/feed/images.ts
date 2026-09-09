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
import { db } from "@/lib/db";
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
/*
 * Fifteen seconds was the budget for a 96px thumbnail, and it was the wrong
 * shape of number entirely.
 *
 * The site is served over HTTP/1.1, so a browser holds six connections to it.
 * A handful of logos on a dead IPFS gateway sat on those connections for
 * fifteen seconds each, and the feed and the chart queued behind them — the
 * page was not slow, it was waiting for artwork. Four seconds is generous for
 * an image this small, and a logo that cannot beat it is not worth a
 * connection slot.
 */
const FETCH_TIMEOUT_MS = 6_000;
/**
 * At most this many logos are fetched at once.
 *
 * Without a cap, warmImages fired one unbounded fetch per launch — about one a
 * second, each racing four gateways — and a cold cache meant hundreds in
 * flight together. The gateways answered that by slowing down, so everything
 * timed out at once. We were the reason the artwork was slow.
 *
 * Six was the overcorrection. The counters caught it: of 290 requests, 95 gave
 * up waiting for a slot while exactly one logo turned out to be genuinely
 * missing. Gateways answer in about five seconds under load, so six at a time
 * is roughly one logo a second against a feed that launches one a second —
 * no headroom at all, and none for the backlog after a restart.
 *
 * Twenty-four is still a cap, and still nothing like the hundreds that caused
 * the original problem. These are cheap outbound sockets on a server, not the
 * six connections a browser gets.
 */
const MAX_INFLIGHT = 24;
/**
 * How long a failed logo is left alone — and why there are two answers.
 *
 * A single ten-minute rule was wrong, and wrong in the worst direction. A
 * gateway timing out under load is a temporary fact about that moment; a CID
 * nobody hosts is a permanent fact about the image. Treating them alike meant
 * one bad minute blacklisted most of the feed for ten, and because the 404 was
 * cached in the browser too, the artwork went away and stayed away.
 *
 * So a definite miss is remembered, and everything else is a short backoff
 * that lets the next viewer try again.
 */
const FAIL_TTL_MS = 10 * 60_000;
const SOFT_TTL_MS = 30_000;

interface Failure {
  at: number;
  ttl: number;
}
const fx = globalThis as typeof globalThis & { __ponsImgFail?: Map<string, Failure> };
function failures(): Map<string, Failure> {
  fx.__ponsImgFail ??= new Map();
  return fx.__ponsImgFail;
}

/**
 * Is this a fact about the image, or about right now?
 *
 * Only a gateway that answers — and says the thing is missing or is not an
 * image — tells us something durable. A timeout, a rate limit or a 5xx says
 * the gateway is busy, which it will not be forever.
 */
function isPermanent(err: unknown): boolean {
  const m = String(err instanceof Error ? err.message : err);
  return m === "404" || m === "410" || m === "not an image" || m === "too big";
}

/** Did this logo fail recently enough that it is not worth trying again? */
export function recentlyFailed(raw: string): boolean {
  const f = failures().get(raw);
  if (!f) return false;
  if (Date.now() - f.at < f.ttl) return true;
  failures().delete(raw);
  return false;
}

/*
 * A plain semaphore. Six at a time, the rest waiting their turn.
 *
 * Queued here rather than at the route, so the background warm and a viewer's
 * request share one budget — two queues against the same gateways would just
 * be the old problem with extra steps.
 */
let active = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_INFLIGHT) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
    // A freed slot is the only moment the backlog can make progress.
    pump();
  }
}

/*
 * Counters, because two guesses at this have now been wrong.
 *
 * The disk cache holds three quarters of the feed's logos and yet only half of
 * them serve, and no theory of mine survives both those numbers. These say
 * which stage is losing them rather than inviting another theory.
 */
/*
 * globalThis-backed, like everything else here that two module instances can
 * touch. Without it the sweep and the route each increment their own copy, and
 * the numbers disagree with each other — the failure map said 615 entries
 * while the counters claimed 32 failures, which is how this was noticed.
 */
interface Stats {
  asked: number;
  fromMemOrDisk: number;
  fetched: number;
  hardFail: number;
  softFail: number;
  gaveUpWaiting: number;
  blocked: number;
  cacheHit: number;
}
const sg = globalThis as typeof globalThis & { __ponsImgStats?: Stats };
const stats: Stats =
  sg.__ponsImgStats ??
  (sg.__ponsImgStats = {
    asked: 0,
    fromMemOrDisk: 0,
    fetched: 0,
    hardFail: 0,
    softFail: 0,
    gaveUpWaiting: 0,
    blocked: 0,
    cacheHit: 0,
  });
export function imageStats() {
  return {
    ...stats,
    queued: waiting.length,
    active,
    backlog: backlog().size,
    failMapSize: failures().size,
  };
}

/**
 * Logos waiting to be warmed, kept until they are.
 *
 * warmImages used to give up on the rest of a batch when the queue was busy,
 * and a launch is warmed exactly once — when it is indexed. So every coin that
 * happened to land during a busy moment never had its artwork fetched at all,
 * and the newest rows, which are the ones anybody actually looks at, were the
 * ones missing pictures. Dropped work looked like backpressure and was really
 * just loss.
 *
 * Now the busy moment defers rather than discards, and the pump comes back for
 * them as slots free.
 */
const bg = globalThis as typeof globalThis & { __ponsImgBacklog?: Set<string> };
function backlog(): Set<string> {
  bg.__ponsImgBacklog ??= new Set();
  return bg.__ponsImgBacklog;
}
/** Bounded, so a feed nobody is watching cannot grow it without limit. */
const MAX_BACKLOG = 2_000;
/*
 * Slots the backlog will not touch.
 *
 * Warming is work nobody asked for yet; a viewer looking at the page has. This
 * keeps a third of the budget free for them, so background work can never be
 * the reason a visible row has no picture.
 */
const RESERVED_FOR_VIEWERS = 8;

function pump(): void {
  const q = backlog();
  while (active < MAX_INFLIGHT - RESERVED_FOR_VIEWERS && q.size > 0) {
    const next = q.values().next().value as string;
    q.delete(next);
    if (cached(next) || recentlyFailed(next)) continue;
    void resolveImage(next).catch(() => {});
  }
}
/** Counted at the route, which is the only place that knows a viewer waited. */
export function noteImage(k: "asked" | "gaveUpWaiting" | "blocked" | "cacheHit"): void {
  stats[k]++;
}

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

/*
 * A second cache, on disk, behind the one in memory.
 *
 * The memory cache dies with the process, and this app is redeployed by
 * rebuilding its container — so every deploy threw away every logo and left
 * the next few hundred visitors waiting on IPFS gateways that take seconds on
 * a cold CID. That is exactly what "the images stopped loading again" looks
 * like from outside, and it had nothing to do with the image code.
 *
 * Cheap now in a way it was not before: since logos are resized to 96px WebP
 * they are two or three kilobytes each, so the whole 800-entry cache is a
 * couple of megabytes on the volume that already holds the index.
 */
function ensureTable(): void {
  db().exec(`
    CREATE TABLE IF NOT EXISTS img_cache (
      url  TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      body BLOB NOT NULL,
      at   INTEGER NOT NULL
    )
  `);
}

let tableReady = false;
function store(): ReturnType<typeof db> | null {
  try {
    if (!tableReady) {
      ensureTable();
      tableReady = true;
    }
    return db();
  } catch {
    // No database is survivable: the memory cache still works, the site is
    // just slower after a restart. It is not worth failing an image over.
    return null;
  }
}

/** Read one logo back off the volume, or null. */
function fromDisk(raw: string): CachedImage | null {
  const d = store();
  if (!d) return null;
  try {
    const row = d
      .prepare(`SELECT type, body, at FROM img_cache WHERE url = ?`)
      .get(raw) as { type?: string; body?: Uint8Array; at?: number } | undefined;
    if (!row?.body || !row.type || !row.at) return null;
    const copy = new ArrayBuffer(row.body.byteLength);
    new Uint8Array(copy).set(row.body);
    return { at: row.at, type: row.type, body: copy };
  } catch {
    return null;
  }
}

function toDisk(raw: string, e: CachedImage): void {
  const d = store();
  if (!d) return;
  try {
    d.prepare(
      `INSERT INTO img_cache (url, type, body, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET type = excluded.type, body = excluded.body, at = excluded.at`,
    ).run(raw, e.type, new Uint8Array(e.body), e.at);
  } catch {
    /* a cache that cannot write is still a cache that can read */
  }
}

export function cached(raw: string): CachedImage | null {
  const hit = cache().get(raw);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  /*
   * Disk is checked on a memory miss, and a disk hit is promoted back into
   * memory. No TTL on the way back: a token's artwork does not change, and
   * re-fetching a logo we already hold to prove it is still the same picture
   * is the whole cost this cache exists to avoid.
   */
  const onDisk = fromDisk(raw);
  if (onDisk) {
    const c = cache();
    if (c.size >= MAX_ENTRIES) c.delete(c.keys().next().value as string);
    c.set(raw, { ...onDisk, at: Date.now() });
    return onDisk;
  }
  return null;
}

/** Fetch and cache one logo. Resolves to null when nothing serves it. */
export async function resolveImage(raw: string): Promise<CachedImage | null> {
  const hit = cached(raw);
  if (hit) {
    stats.fromMemOrDisk++;
    return hit;
  }
  const running = inFlight().get(raw);
  if (running) return running;
  const p = withSlot(() => fetchImage(raw));
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
      // The status is the message, so isPermanent can tell 404 from 503.
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
    } catch (err) {
      /*
       * Every gateway failed. Remembered so the next viewer does not spend
       * another six seconds finding out the same thing — but for ten minutes
       * only when every gateway agreed the image is genuinely not there, and
       * for thirty seconds when they were merely busy.
       */
      const errs = (err as AggregateError)?.errors ?? [err];
      const permanent = errs.length > 0 && errs.every(isPermanent);
      if (permanent) stats.hardFail++;
      else stats.softFail++;
      const f = failures();
      if (f.size > 5_000) f.clear();
      f.set(raw, { at: Date.now(), ttl: permanent ? FAIL_TTL_MS : SOFT_TTL_MS });
      return null;
    } finally {
      // Stop the losers downloading bytes nobody will look at.
      ctrl.abort();
    }

    const c = cache();
    if (c.size >= MAX_ENTRIES) c.delete(c.keys().next().value as string);
    c.set(raw, entry);
    toDisk(raw, entry);
    stats.fetched++;
    return entry;
  } finally {
    inFlight().delete(raw);
  }
}

/**
 * Fire-and-forget warm for freshly indexed launches. Never throws.
 *
 * Yields to viewers. Warming is an optimisation — it makes a logo ready before
 * anybody asks — so when the queue is already backed up it is the thing that
 * should wait, not the request from someone looking at the page right now.
 */
export function warmImages(logos: (string | null | undefined)[]): void {
  const q = backlog();
  for (const l of logos) {
    if (!l || l.length > 512 || cached(l) || recentlyFailed(l)) continue;
    if (q.size >= MAX_BACKLOG) break;
    q.add(l);
  }
  pump();
}
