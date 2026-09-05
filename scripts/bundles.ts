/**
 * Who is actually one person? Wallet clustering from co-occurrence.
 *
 *   npm run bundles
 *   npm run bundles -- --minTokens 3 --minPairs 4 --minLift 25
 *
 * Every count we have treats each address as a separate person. The research on
 * this market says that is the single biggest thing we are getting wrong: on
 * Solana launches, 36.5% of supply sits in bundled accounts, and bundle
 * statistics are the second most predictive feature group after raw market
 * activity. A launch with "20 buyers" and a launch with one operator running 20
 * wallets look identical to us, and they are not remotely the same trade.
 *
 * The classic detection is fund-flow: wallets funded from a common source right
 * before launch. That needs native-transfer history, which is not in event logs
 * and is expensive to reconstruct. This finds the same operators a different
 * way, from data already on disk and with no RPC at all:
 *
 *   Two wallets that keep turning up early on the SAME tokens are very unlikely
 *   to be two independent traders. With ~114k launches, a genuine coincidence
 *   of 4+ shared launches between a specific pair is vanishingly rare, so a
 *   high co-occurrence LIFT (observed / expected-by-chance) marks one operator.
 *
 * Wallets are then joined into clusters with union-find, and each token scores
 * by the largest single cluster among its early buyers. That score is what a
 * "how many people really bought this" filter should use instead of a headcount.
 *
 * Offline: reads data/reputation.sqlite's sources. No RPC.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const SOURCES = [
  "./data/scan.sqlite",
  "./data/scan-rep.sqlite",
  "./data/scan-dip.sqlite",
  "./data/scan-grad.sqlite",
];
const OUT = "./data/bundles.sqlite";

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1]);
    if (Number.isFinite(n)) return n;
  }
  return dflt;
}
/** Ignore one-off wallets: a pair needs history before co-occurrence means anything. */
const MIN_TOKENS = arg("minTokens", 3);
/** Shared launches before a pair is even considered. */
const MIN_PAIRS = arg("minPairs", 4);
/** How many times more often than chance the pair must co-occur. */
const MIN_LIFT = arg("minLift", 25);
/**
 * Causal mode: build clusters ONLY from launches in the first half of the
 * window, then score launches in the second half with them.
 *
 * Without this the test cheats. A wallet's cluster is derived from its whole
 * history, including tokens that launched AFTER the one being scored, so at the
 * moment of the decision we would not have known it. The same trap turned a
 * 70.8% picking rule into 67.3% once it was cleaned up, and there it survived —
 * here it might not, because a cluster needs several shared launches to appear
 * at all, and a young operator has none of them yet.
 */
const CAUSAL = process.argv.includes("--causal");

interface Launch {
  token: string;
  deployer: string;
  graduated: number;
  unique_buyers: number;
  launch_block: number;
}

// ── load, deduplicated across whichever scans are present ────────────────────
const launches = new Map<string, Launch>();
const tokenBuyers = new Map<string, Set<string>>();
let used = 0;
for (const src of SOURCES) {
  if (!existsSync(src)) continue;
  used++;
  const db = new DatabaseSync(src, { readOnly: true });
  for (const r of db
    .prepare("SELECT token, deployer, graduated, unique_buyers, launch_block FROM launches")
    .all() as unknown as Launch[]) {
    const t = r.token.toLowerCase();
    const prev = launches.get(t);
    // Graduated anywhere means graduated: a scan may simply have stopped early.
    launches.set(t, {
      token: t,
      deployer: r.deployer.toLowerCase(),
      graduated: Math.max(prev?.graduated ?? 0, r.graduated ? 1 : 0),
      unique_buyers: Math.max(prev?.unique_buyers ?? 0, r.unique_buyers ?? 0),
      launch_block: prev?.launch_block ?? r.launch_block,
    });
  }
  for (const r of db.prepare("SELECT token, wallet FROM early_buyers").all() as unknown as {
    token: string;
    wallet: string;
  }[]) {
    const t = r.token.toLowerCase();
    let s = tokenBuyers.get(t);
    if (!s) tokenBuyers.set(t, (s = new Set()));
    s.add(r.wallet.toLowerCase());
  }
  db.close();
}
if (!used) {
  console.error("\nNo scan database found. Run `npm run scan` first.\n");
  process.exit(1);
}

console.log(`\nwallet clustering — ${launches.size} launches, ${tokenBuyers.size} with buyer lists\n`);

// In causal mode only the first half of the window may inform the clusters.
const blocks = [...launches.values()].map((l) => l.launch_block).sort((a, b) => a - b);
const SPLIT = blocks[Math.floor(blocks.length / 2)] ?? 0;
const mayTeach = (token: string) =>
  !CAUSAL || (launches.get(token)?.launch_block ?? Infinity) < SPLIT;
const mayScore = (token: string) =>
  !CAUSAL || (launches.get(token)?.launch_block ?? -1) >= SPLIT;
if (CAUSAL) {
  console.log(`  CAUSAL: clusters learned below block ${SPLIT}, scored at or above it
`);
}

// ── how many launches is each wallet early on? ───────────────────────────────
const walletCount = new Map<string, number>();
for (const [t, set] of tokenBuyers) {
  if (!mayTeach(t)) continue;
  for (const w of set) walletCount.set(w, (walletCount.get(w) ?? 0) + 1);
}

// Only wallets with some history can form a meaningful pair, and dropping the
// one-offs is what makes the pair pass tractable: it is quadratic per token.
const active = new Map<string, number>(); // wallet -> dense id
const activeCount: number[] = [];
for (const [w, n] of walletCount) {
  if (n < MIN_TOKENS) continue;
  active.set(w, activeCount.length);
  activeCount.push(n);
}
console.log(`  ${walletCount.size} distinct early buyers, ${active.size} seen on ${MIN_TOKENS}+ launches`);

// ── pairwise co-occurrence among those wallets ───────────────────────────────
// Keys are packed as a*BASE+b with a<b, so one number per pair rather than a
// string; at this scale string keys cost gigabytes.
const BASE = 1_000_000;
const pairs = new Map<number, number>();
let tokensScanned = 0;
for (const [t, set] of tokenBuyers) {
  if (!mayTeach(t)) continue;
  const ids: number[] = [];
  for (const w of set) {
    const id = active.get(w);
    if (id !== undefined) ids.push(id);
  }
  if (ids.length < 2) continue;
  ids.sort((a, b) => a - b);
  tokensScanned++;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const k = ids[i] * BASE + ids[j];
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
  }
}
console.log(`  ${pairs.size} wallet pairs share at least one launch (${tokensScanned} tokens contributed)`);

// ── keep only pairs far beyond chance ────────────────────────────────────────
// Expected shared launches if independent: n_a * n_b / totalTokens.
const total = CAUSAL ? [...tokenBuyers.keys()].filter(mayTeach).length : tokenBuyers.size;
const linked: [number, number][] = [];
for (const [k, shared] of pairs) {
  if (shared < MIN_PAIRS) continue;
  const a = Math.floor(k / BASE);
  const b = k % BASE;
  const expected = (activeCount[a] * activeCount[b]) / total;
  if (expected <= 0) continue;
  if (shared / expected >= MIN_LIFT) linked.push([a, b]);
}
console.log(`  ${linked.length} pairs co-occur ${MIN_LIFT}x beyond chance on ${MIN_PAIRS}+ launches\n`);

// ── union-find into operator clusters ────────────────────────────────────────
const parent = new Int32Array(active.size);
for (let i = 0; i < parent.length; i++) parent[i] = i;
function find(x: number): number {
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]];
    x = parent[x];
  }
  return x;
}
for (const [a, b] of linked) {
  const ra = find(a);
  const rb = find(b);
  if (ra !== rb) parent[ra] = rb;
}
const clusterSize = new Map<number, number>();
for (let i = 0; i < parent.length; i++) {
  const r = find(i);
  clusterSize.set(r, (clusterSize.get(r) ?? 0) + 1);
}
const multi = [...clusterSize.entries()].filter(([, n]) => n > 1);
multi.sort((x, y) => y[1] - x[1]);
console.log(`  ${multi.length} clusters of 2+ wallets; largest ${multi[0]?.[1] ?? 0} wallets`);
console.log(`  ${multi.reduce((s, [, n]) => s + n, 0)} wallets belong to a cluster\n`);

// ── score every token by its biggest cluster ─────────────────────────────────
const idToWallet: string[] = new Array(active.size);
for (const [w, id] of active) idToWallet[id] = w;

interface Scored {
  token: string;
  buyers: number;
  biggestCluster: number;
  graduated: number;
}
const scored: Scored[] = [];
for (const [token, set] of tokenBuyers) {
  const L = launches.get(token);
  if (!L) continue;
  if (!mayScore(token)) continue;
  const counts = new Map<number, number>();
  for (const w of set) {
    const id = active.get(w);
    if (id === undefined) continue;
    const r = find(id);
    if ((clusterSize.get(r) ?? 1) < 2) continue; // not part of any cluster
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  let biggest = 0;
  for (const [, n] of counts) if (n > biggest) biggest = n;
  scored.push({ token, buyers: set.size, biggestCluster: biggest, graduated: L.graduated });
}

// ── does it predict anything? ────────────────────────────────────────────────
console.log("DOES COORDINATION PREDICT THE OUTCOME?");
console.log("  biggest cluster among early buyers        n   graduated");
const bands: [string, (s: Scored) => boolean][] = [
  ["0 — no clustered wallets", (s) => s.biggestCluster === 0],
  ["2 wallets", (s) => s.biggestCluster === 2],
  ["3-4 wallets", (s) => s.biggestCluster >= 3 && s.biggestCluster <= 4],
  ["5-9 wallets", (s) => s.biggestCluster >= 5 && s.biggestCluster <= 9],
  ["10+ wallets", (s) => s.biggestCluster >= 10],
];
for (const [label, f] of bands) {
  const a = scored.filter(f);
  if (a.length < 30) continue;
  const g = a.reduce((s, x) => s + x.graduated, 0);
  console.log(`  ${label.padEnd(34)}${String(a.length).padStart(7)}${((g / a.length) * 100).toFixed(2).padStart(11)}%`);
}
const base = scored.reduce((s, x) => s + x.graduated, 0) / scored.length;
console.log(`\n  baseline across all ${scored.length} scored tokens: ${(base * 100).toFixed(2)}%`);

// ── what a headcount actually means once clusters collapse ───────────────────
console.log(`\nHOW INFLATED IS THE BUYER COUNT?`);
const withCluster = scored.filter((s) => s.biggestCluster >= 2);
if (withCluster.length) {
  const avgBuyers = withCluster.reduce((s, x) => s + x.buyers, 0) / withCluster.length;
  const avgCluster = withCluster.reduce((s, x) => s + x.biggestCluster, 0) / withCluster.length;
  console.log(
    `  ${withCluster.length} tokens have a clustered group among their early buyers ` +
      `(${((withCluster.length / scored.length) * 100).toFixed(1)}% of all)`,
  );
  console.log(
    `  on those, the average headcount is ${avgBuyers.toFixed(1)} but ${avgCluster.toFixed(1)} of them ` +
      `are one operator — a real count of ~${(avgBuyers - avgCluster + 1).toFixed(1)}`,
  );
}

// ── persist so filters and later analyses can use it ─────────────────────────
const out = new DatabaseSync(OUT);
out.exec("PRAGMA journal_mode = WAL;");
out.exec(`
  DROP TABLE IF EXISTS wallet_cluster;
  DROP TABLE IF EXISTS token_bundle;
  CREATE TABLE wallet_cluster (wallet TEXT PRIMARY KEY, cluster INTEGER, cluster_size INTEGER);
  CREATE TABLE token_bundle (token TEXT PRIMARY KEY, buyers INTEGER, biggest_cluster INTEGER, graduated INTEGER);
  CREATE INDEX i_wc ON wallet_cluster(cluster);
`);
const iw = out.prepare("INSERT OR REPLACE INTO wallet_cluster VALUES (?,?,?)");
const it = out.prepare("INSERT OR REPLACE INTO token_bundle VALUES (?,?,?,?)");
out.exec("BEGIN");
for (let i = 0; i < parent.length; i++) {
  const r = find(i);
  const size = clusterSize.get(r) ?? 1;
  if (size < 2) continue;
  iw.run(idToWallet[i], r, size);
}
for (const s of scored) it.run(s.token, s.buyers, s.biggestCluster, s.graduated);
out.exec("COMMIT");
console.log(`\nwritten to ${OUT}\n`);
