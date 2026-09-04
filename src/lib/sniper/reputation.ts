import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

/**
 * Read-only lookup over data/reputation.sqlite, built by `npm run reputation`.
 *
 * Backs the only two filters in this project that testing supported: excluding
 * serial deployers who have never produced a graduate, and requiring that some
 * of a curve's existing buyers have previously been early on one.
 *
 * With no database every lookup returns a neutral answer: an unknown deployer
 * reads as a first-timer, which is the BEST bucket in the data, so the deployer
 * filter simply stops excluding anyone. The proven-buyer filter is the opposite
 * case and refuses instead — silently no-opping there would turn "only buy what
 * proven wallets are buying" into "buy everything", which is how a safety
 * setting becomes the exact risk it was added to prevent.
 */

/**
 * Resolved when the store is opened rather than at import, so the path is not
 * frozen by whichever module happened to load first.
 */
function reputationPath(): string {
  return process.env.REPUTATION_PATH ?? "./data/reputation.sqlite";
}

export interface DeployerRecord {
  /** Launches this deployer has made in the scanned history. */
  launches: number;
  /** How many of those graduated. */
  graduated: number;
}

interface Store {
  db: DatabaseSync | null;
  deployer: ReturnType<DatabaseSync["prepare"]> | null;
  wallet: ReturnType<DatabaseSync["prepare"]> | null;
  builtAt: string | null;
  tokens: number;
}

// Instrumentation and route handlers run in separate module registries, so a
// module-scoped handle would open the file twice. Repo rule: any singleton
// touched by both must be globalThis-backed.
const KEY = "__pons_reputation__";
type G = typeof globalThis & { [KEY]?: Store };

function store(): Store {
  const g = globalThis as G;
  if (g[KEY]) return g[KEY]!;

  const s: Store = { db: null, deployer: null, wallet: null, builtAt: null, tokens: 0 };
  const path = reputationPath();
  if (existsSync(path)) {
    try {
      s.db = new DatabaseSync(path, { readOnly: true });
      s.deployer = s.db.prepare("SELECT launches, graduated FROM deployers WHERE addr = ?");
      s.wallet = s.db.prepare("SELECT graduates FROM wallets WHERE addr = ?");
      const meta = s.db.prepare("SELECT k, v FROM meta").all() as unknown as { k: string; v: string }[];
      for (const m of meta) {
        if (m.k === "built_at") s.builtAt = m.v;
        if (m.k === "tokens") s.tokens = Number(m.v) || 0;
      }
    } catch {
      // A corrupt or half-written file must not take the engine down with it.
      s.db = null;
      s.deployer = null;
      s.wallet = null;
    }
  }
  g[KEY] = s;
  return s;
}

/** Is a reputation database loaded? Filters relying on it no-op when false. */
export function reputationAvailable(): boolean {
  return store().db !== null;
}

export function reputationInfo(): { available: boolean; builtAt: string | null; tokens: number } {
  const s = store();
  return { available: s.db !== null, builtAt: s.builtAt, tokens: s.tokens };
}

/** What we know about a deployer. Unknown deployers look like first-timers. */
export function deployerRecord(addr: string): DeployerRecord {
  const s = store();
  if (!s.deployer) return { launches: 0, graduated: 0 };
  try {
    const r = s.deployer.get(addr.toLowerCase()) as unknown as DeployerRecord | undefined;
    // node:sqlite hands back null-prototype rows; copy into a plain object so
    // callers (and deepEqual in tests) see a normal shape with real numbers.
    return r ? { launches: Number(r.launches), graduated: Number(r.graduated) } : { launches: 0, graduated: 0 };
  } catch {
    return { launches: 0, graduated: 0 };
  }
}

/**
 * A wallet is "proven" if it was an early buyer of at least one token that went
 * on to graduate. Scored only on tokens that finished BEFORE the one being
 * judged, since the database is built from completed history.
 */
export function isProvenBuyer(addr: string): boolean {
  const s = store();
  if (!s.wallet) return false;
  try {
    const r = s.wallet.get(addr.toLowerCase()) as unknown as { graduates: number } | undefined;
    return (r?.graduates ?? 0) > 0;
  } catch {
    return false;
  }
}

/** How many of these wallets are proven. Duplicates count once. */
export function countProvenBuyers(addrs: Iterable<string>): number {
  const s = store();
  if (!s.wallet) return 0;
  let n = 0;
  const seen = new Set<string>();
  for (const a of addrs) {
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    if (isProvenBuyer(k)) n++;
  }
  return n;
}

/** Test seam: drop the cached handle so a rebuilt database is picked up. */
export function resetReputation(): void {
  const g = globalThis as G;
  try {
    g[KEY]?.db?.close();
  } catch {
    /* already closed */
  }
  delete g[KEY];
}
