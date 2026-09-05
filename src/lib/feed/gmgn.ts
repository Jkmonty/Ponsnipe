/**
 * New pairs from GMGN.
 *
 * Our own indexer only sees pons bonding curves. Measured against the chain,
 * that is a minority of what launches here: in a ten-minute window there were
 * 246 pons launches and 126 new Uniswap V4 pools, of which only 14 tokens were
 * known to the pons factory and 84 were not. Those 84 are real coins on real
 * launchpads — `longxyz`, `flap` and others — and no amount of tuning our own
 * sweep would surface them, because they never touch a curve we watch.
 *
 * GMGN indexes all of them, plus per-token risk fields we would not
 * realistically build ourselves: bundler rates, dev hold share, fresh-wallet
 * share, creator history, honeypot and tax checks.
 *
 * Auth is Ed25519 request signing handled by their CLI, so this shells out to
 * it rather than reimplementing the signature. The key lives in
 * ~/.config/gmgn/.env and is never read by this process.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { db, logEngine } from "../db/index";

/** GMGN quota is per-key, so this is deliberately slower than the chain sweep. */
const POLL_MS = Math.max(10_000, Number(process.env.GMGN_POLL_MS ?? 20_000));
const CHAIN = process.env.GMGN_CHAIN?.trim() || "robinhood";
const LIMIT = Math.min(80, Math.max(1, Number(process.env.GMGN_LIMIT ?? 80)));
/** Rows older than this leave the table. */
const KEEP_MINUTES = 180;

interface GmgnState {
  running: boolean;
  timer: ReturnType<typeof setInterval> | undefined;
  polls: number;
  rows: number;
  lastError: string | null;
  lastAt: number;
  busy: boolean;
}

const g = globalThis as typeof globalThis & { __ponsGmgn?: GmgnState };
const s: GmgnState =
  g.__ponsGmgn ??
  (g.__ponsGmgn = {
    running: false,
    timer: undefined,
    polls: 0,
    rows: 0,
    lastError: null,
    lastAt: 0,
    busy: false,
  });

function migrate(): void {
  db().exec(`
    CREATE TABLE IF NOT EXISTS gmgn_tokens (
      address        TEXT PRIMARY KEY,
      symbol         TEXT,
      name           TEXT,
      logo           TEXT,
      launchpad      TEXT,
      exchange       TEXT,
      pool_address   TEXT,
      created_ts     INTEGER,
      price          REAL,
      market_cap     REAL,
      liquidity      REAL,
      volume_24h     REAL,
      swaps_24h      INTEGER,
      buys_24h       INTEGER,
      sells_24h      INTEGER,
      holder_count   INTEGER,
      progress       REAL,
      -- the risk fields, which are the part we could not build ourselves
      creator             TEXT,
      creator_made       INTEGER,
      dev_hold_rate      REAL,
      top10_hold_rate    REAL,
      fresh_wallet_rate  REAL,
      bot_degen_rate     REAL,
      sniper_hold_rate   REAL,
      insider_hold_rate  REAL,
      is_honeypot        TEXT,
      buy_tax            REAL,
      sell_tax           REAL,
      renowned_count     INTEGER,
      twitter            TEXT,
      website            TEXT,
      seen_at            TEXT NOT NULL,
      category           TEXT
    );
  `);
  // CREATE TABLE IF NOT EXISTS will not add a column to a table that already
  // exists, so anything added after the first release has to be bolted on.
  try {
    db().exec(`ALTER TABLE gmgn_tokens ADD COLUMN category TEXT;`);
  } catch {
    /* already present */
  }
  db().exec(`CREATE INDEX IF NOT EXISTS idx_gmgn_created ON gmgn_tokens(created_ts DESC);`);
}

/**
 * Their payload nests the list under one of several keys depending on the
 * endpoint and version, so find the first array rather than assume a shape.
 */
function extract(payload: unknown): Record<string, unknown>[] {
  const seen = new Set<unknown>();
  const walk = (o: unknown, depth: number): Record<string, unknown>[] => {
    if (depth > 6 || o == null || seen.has(o)) return [];
    if (Array.isArray(o)) {
      return o.every((x) => x && typeof x === "object" && "address" in (x as object))
        ? (o as Record<string, unknown>[])
        : [];
    }
    if (typeof o !== "object") return [];
    seen.add(o);
    for (const v of Object.values(o as Record<string, unknown>)) {
      const hit = walk(v, depth + 1);
      if (hit.length) return hit;
    }
    return [];
  };
  return walk(payload, 0);
}

/**
 * Path to the CLI's own entry script.
 *
 * Deliberately not `execFile("gmgn-cli", ...)`: on Windows that resolves to a
 * .cmd shim which needs `shell: true` to spawn, and a shell concatenates rather
 * than escapes its arguments. Running the script under this process's own node
 * binary keeps arguments as a real argv array with no shell in between.
 */
function cliEntry(): string {
  const req = createRequire(import.meta.url);
  try {
    return req.resolve("gmgn-cli/dist/index.js");
  } catch {
    const npm = process.env.APPDATA
      ? join(process.env.APPDATA, "npm", "node_modules", "gmgn-cli", "dist", "index.js")
      : "/usr/local/lib/node_modules/gmgn-cli/dist/index.js";
    return npm;
  }
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliEntry(), ...args],
      { timeout: 60_000, maxBuffer: 24 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).slice(0, 300)));
        resolve(stdout);
      },
    );
  });
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
/** Their payload is untyped JSON, so coerce before it reaches the statement. */
const str = (v: unknown): string | null =>
  v === null || v === undefined || v === "" ? null : String(v);

async function poll(): Promise<void> {
  if (!s.running || s.busy) return;
  s.busy = true;
  try {
    migrate();
    /*
     * All three categories, not just new_creation.
     *
     * GMGN files a launch by how far along it is, and the fast launchpads
     * dominate new_creation while pons curves surface under near_completion and
     * completed. Fetching only the first would have quietly dropped every coin
     * this app can actually buy.
     */
    const items: Record<string, unknown>[] = [];
    for (const category of ["new_creation", "near_completion", "completed"] as const) {
      const out = await run([
        "market",
        "trenches",
        "--chain",
        CHAIN,
        "--type",
        category,
        "--limit",
        String(LIMIT),
        "--raw",
      ]);
      for (const t of extract(JSON.parse(out))) items.push({ ...t, __category: category });
    }
    if (!items.length) {
      s.lastError = "no rows in response";
      return;
    }

    const ins = db().prepare(
      `INSERT INTO gmgn_tokens
         (address, symbol, name, logo, launchpad, exchange, pool_address, created_ts,
          price, market_cap, liquidity, volume_24h, swaps_24h, buys_24h, sells_24h,
          holder_count, progress, creator, creator_made, dev_hold_rate, top10_hold_rate,
          fresh_wallet_rate, bot_degen_rate, sniper_hold_rate, insider_hold_rate,
          is_honeypot, buy_tax, sell_tax, renowned_count, twitter, website, seen_at, category)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(address) DO UPDATE SET
         price=excluded.price, market_cap=excluded.market_cap, liquidity=excluded.liquidity,
         volume_24h=excluded.volume_24h, swaps_24h=excluded.swaps_24h,
         buys_24h=excluded.buys_24h, sells_24h=excluded.sells_24h,
         holder_count=excluded.holder_count, progress=excluded.progress,
         dev_hold_rate=excluded.dev_hold_rate, top10_hold_rate=excluded.top10_hold_rate,
         fresh_wallet_rate=excluded.fresh_wallet_rate, bot_degen_rate=excluded.bot_degen_rate,
         sniper_hold_rate=excluded.sniper_hold_rate, insider_hold_rate=excluded.insider_hold_rate,
         is_honeypot=excluded.is_honeypot, renowned_count=excluded.renowned_count,
         seen_at=excluded.seen_at, category=excluded.category`,
    );
    const at = new Date().toISOString();
    let n = 0;
    for (const t of items) {
      const addr = String(t.address ?? "").toLowerCase();
      if (!addr) continue;
      ins.run(
        addr,
        str(t.symbol),
        str(t.name),
        str(t.logo),
        str(t.launchpad ?? t.launchpad_platform),
        str(t.exchange),
        str(t.pool_address),
        num(t.created_timestamp),
        num(t.price),
        num(t.market_cap),
        num(t.liquidity),
        num(t.volume_24h),
        num(t.swaps_24h),
        num(t.buys_24h),
        num(t.sells_24h),
        num(t.holder_count),
        num(t.progress),
        str(t.creator),
        num(t.creator_created_count),
        num(t.dev_team_hold_rate),
        num(t.top_10_holder_rate),
        num(t.fresh_wallet_rate),
        num(t.bot_degen_rate),
        num(t.top70_sniper_hold_rate),
        num(t.suspected_insider_hold_rate),
        String(t.is_honeypot ?? "unknown"),
        num(t.buy_tax),
        num(t.sell_tax),
        num(t.renowned_count),
        str(t.twitter),
        str(t.website),
        at,
        str(t.__category),
      );
      n++;
    }
    s.rows = n;
    s.polls += 1;
    s.lastAt = Date.now();
    s.lastError = null;

    if (s.polls % 20 === 0) {
      db()
        .prepare(`DELETE FROM gmgn_tokens WHERE seen_at < ?`)
        .run(new Date(Date.now() - KEEP_MINUTES * 60_000).toISOString());
    }
  } catch (err) {
    s.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    logEngine("warn", `gmgn poll failed: ${s.lastError}`);
  } finally {
    s.busy = false;
  }
}

/** True when the CLI reports a usable key, so the feed can pick a source. */
export async function gmgnConfigured(): Promise<boolean> {
  try {
    await run(["config", "--check"]);
    return true;
  } catch {
    return false;
  }
}

export function startGmgn(): void {
  if (s.running) return;
  s.running = true;
  try {
    migrate();
  } catch (err) {
    logEngine("error", `gmgn migrate failed: ${String(err)}`);
  }
  s.timer = setInterval(() => void poll(), POLL_MS);
  if (s.timer && typeof s.timer === "object" && "unref" in s.timer) s.timer.unref();
  void poll();
  logEngine("info", `gmgn feed started (${CHAIN}, every ${POLL_MS / 1000}s)`);
}

export function stopGmgn(): void {
  s.running = false;
  if (s.timer) clearInterval(s.timer);
  s.timer = undefined;
}

export function gmgnStatus() {
  return {
    running: s.running,
    polls: s.polls,
    rows: s.rows,
    lastError: s.lastError,
    ageSeconds: s.lastAt ? Math.round((Date.now() - s.lastAt) / 1000) : null,
  };
}
