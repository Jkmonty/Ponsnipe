/**
 * Wallets that are really one operator.
 *
 * `npm run bundles` clusters addresses by their funding graph and writes
 * data/bundles.sqlite. This reads that back so the feed can say how much of a
 * coin's "crowd" is one person wearing several hats — which is the difference
 * between a token with 35 holders and a token with 35 wallets.
 *
 * Entirely optional. Without the database every row simply reports zero, and
 * nothing else in the feed changes; it is an extra column of judgement, not
 * something the app depends on.
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const PATH = process.env.BUNDLES_PATH ?? "./data/bundles.sqlite";

const g = globalThis as typeof globalThis & {
  __ponsClusters?: Map<string, number> | null;
};

/**
 * wallet -> cluster id, loaded once.
 *
 * Held in memory rather than joined in SQL because it lives in a different
 * database file from the feed, and at ~5,400 wallets the whole map is smaller
 * than a single page of the feed. null means "looked and there was nothing",
 * so a missing file is not re-checked on every request.
 */
function clusters(): Map<string, number> {
  if (g.__ponsClusters !== undefined && g.__ponsClusters !== null) return g.__ponsClusters;
  if (g.__ponsClusters === null) return new Map();

  if (!existsSync(PATH)) {
    g.__ponsClusters = null;
    return new Map();
  }
  try {
    const db = new DatabaseSync(PATH, { readOnly: true });
    const m = new Map<string, number>();
    for (const r of db.prepare("SELECT wallet, cluster FROM wallet_cluster").all() as {
      wallet: string;
      cluster: number;
    }[]) {
      m.set(String(r.wallet).toLowerCase(), r.cluster);
    }
    db.close();
    g.__ponsClusters = m;
    return m;
  } catch {
    g.__ponsClusters = null;
    return new Map();
  }
}

/** True when a bundle database was found, so the UI can distinguish 0 from unknown. */
export function clustersAvailable(): boolean {
  clusters();
  return g.__ponsClusters != null && g.__ponsClusters.size > 0;
}

/**
 * The largest number of a curve's buyers belonging to one operator.
 *
 * Returned per curve, from rows of (curve, wallet). One is meaningless — every
 * clustered wallet is trivially a cluster of one — so anything below two is
 * reported as zero.
 *
 * Note what this cannot see: the cluster database is built by a scan, so a
 * wallet created after that scan is unknown and counts as its own person.
 * Measured against the live feed, 15.9% of buyers were in a known cluster, so
 * this is a floor on how bundled a launch is, never a ceiling.
 */
export function bundledByCurve(rows: { curve: string; wallet: string }[]): Map<string, number> {
  const map = clusters();
  const out = new Map<string, number>();
  if (!map.size) return out;

  const per = new Map<string, Map<number, number>>();
  for (const r of rows) {
    const cluster = map.get(String(r.wallet).toLowerCase());
    if (cluster === undefined) continue;
    let m = per.get(r.curve);
    if (!m) per.set(r.curve, (m = new Map()));
    m.set(cluster, (m.get(cluster) ?? 0) + 1);
  }
  for (const [curve, m] of per) {
    let biggest = 0;
    for (const n of m.values()) if (n > biggest) biggest = n;
    if (biggest >= 2) out.set(curve, biggest);
  }
  return out;
}
