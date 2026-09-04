/**
 * Build data/reputation.sqlite — the only two signals in this dataset that
 * survived testing.
 *
 *   npm run reputation
 *
 * Everything the sniper filters on today (liquidity band, buy count, velocity,
 * creator tax) was tested across 110k launches and none of it produced a
 * profitable book. Two things did carry signal:
 *
 *   DEPLOYERS — a strong NEGATIVE filter. A first-ever launch graduates at
 *   1.91%; a deployer with 20+ prior launches and none graduated manages 0.17%,
 *   which is 11x worse than baseline. Note the reverse is NOT true: "has a prior
 *   graduate" runs at 1.50% against a 1.46% baseline, so there is no good-dev
 *   whitelist to build here. Only the spammers are worth excluding.
 *
 *   EARLY BUYERS — the one positive. Tokens with 4+ buyers who had ALREADY been
 *   early on something that graduated went on to graduate at 3.64% against a
 *   1.46% baseline, and in the entry-rule grid that filter turned a -3.4% book
 *   into +1.89%. Thin, and its confidence interval touched zero, but it is the
 *   only filter that ever moved a book from negative to positive.
 *
 * Merges every scan database present, deduplicating by token, since they cover
 * overlapping but not identical windows.
 *
 * Reads only, offline. No RPC.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";

const SOURCES = [
  "./data/scan.sqlite",
  "./data/scan-grad.sqlite",
  "./data/scan-rep.sqlite",
  "./data/scan-dip.sqlite",
];
const OUT = "./data/reputation.sqlite";

try {
  mkdirSync("./data", { recursive: true });
} catch {
  /* exists */
}

const db = new DatabaseSync(OUT);
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  DROP TABLE IF EXISTS deployers;
  DROP TABLE IF EXISTS wallets;
  DROP TABLE IF EXISTS meta;
  CREATE TABLE deployers (addr TEXT PRIMARY KEY, launches INTEGER, graduated INTEGER);
  CREATE TABLE wallets (addr TEXT PRIMARY KEY, early_on INTEGER, graduates INTEGER);
  CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
`);

/** token -> graduated, deduplicated across source databases. */
const tokenGrad = new Map<string, number>();
const tokenDeployer = new Map<string, string>();
/** token -> its early buyers. */
const tokenBuyers = new Map<string, Set<string>>();

let sources = 0;
for (const src of SOURCES) {
  if (!existsSync(src)) {
    console.log(`  skip ${src} (not present)`);
    continue;
  }
  sources++;
  const s = new DatabaseSync(src);
  const launches = s
    .prepare("SELECT token, deployer, graduated FROM launches")
    .all() as unknown as { token: string; deployer: string; graduated: number }[];
  for (const r of launches) {
    const t = r.token.toLowerCase();
    // A token seen as graduated anywhere is graduated: a scan whose window
    // ended early may simply not have watched long enough.
    tokenGrad.set(t, Math.max(tokenGrad.get(t) ?? 0, r.graduated ? 1 : 0));
    tokenDeployer.set(t, r.deployer.toLowerCase());
  }
  const buyers = s
    .prepare("SELECT token, wallet FROM early_buyers")
    .all() as unknown as { token: string; wallet: string }[];
  for (const r of buyers) {
    const t = r.token.toLowerCase();
    let set = tokenBuyers.get(t);
    if (!set) tokenBuyers.set(t, (set = new Set()));
    set.add(r.wallet.toLowerCase());
  }
  console.log(`  read ${src}: ${launches.length} launches, ${buyers.length} early-buyer rows`);
  s.close();
}
if (!sources) {
  console.error("\nNo scan database found. Run `npm run scan` first.\n");
  process.exit(1);
}

// ── deployers ────────────────────────────────────────────────────────────────
const dep = new Map<string, { launches: number; graduated: number }>();
for (const [token, deployer] of tokenDeployer) {
  const e = dep.get(deployer) ?? { launches: 0, graduated: 0 };
  e.launches++;
  e.graduated += tokenGrad.get(token) ?? 0;
  dep.set(deployer, e);
}

// ── wallets ──────────────────────────────────────────────────────────────────
const wal = new Map<string, { earlyOn: number; graduates: number }>();
for (const [token, set] of tokenBuyers) {
  const g = tokenGrad.get(token) ?? 0;
  for (const w of set) {
    const e = wal.get(w) ?? { earlyOn: 0, graduates: 0 };
    e.earlyOn++;
    e.graduates += g;
    wal.set(w, e);
  }
}

const insD = db.prepare("INSERT OR REPLACE INTO deployers VALUES (?,?,?)");
const insW = db.prepare("INSERT OR REPLACE INTO wallets VALUES (?,?,?)");
db.exec("BEGIN");
for (const [a, e] of dep) insD.run(a, e.launches, e.graduated);
// Only wallets that ever backed a winner matter to the filter; storing the
// other ~45k would triple the file to answer a question nobody asks.
for (const [a, e] of wal) if (e.graduates > 0) insW.run(a, e.earlyOn, e.graduates);
db.prepare("INSERT OR REPLACE INTO meta VALUES (?,?)").run("built_at", new Date().toISOString());
db.prepare("INSERT OR REPLACE INTO meta VALUES (?,?)").run("tokens", String(tokenGrad.size));
db.exec("COMMIT");

const proven = [...wal.values()].filter((e) => e.graduates > 0).length;
const spammers = [...dep.values()].filter((e) => e.launches >= 20 && e.graduated === 0).length;
const grads = [...tokenGrad.values()].reduce((s, v) => s + v, 0);

console.log(`\nwritten to ${OUT}`);
console.log(`  tokens        ${tokenGrad.size}  (${grads} graduated)`);
console.log(`  deployers     ${dep.size}  of which ${spammers} have 20+ launches and none graduated`);
console.log(`  proven wallets ${proven}  (were early on at least one graduate)`);
console.log(`\nFilter with sniper config: maxDeployerDudLaunches, minProvenBuyers\n`);
