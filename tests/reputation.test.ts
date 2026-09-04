import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The two reputation filters carry the only signals that survived testing, and
 * they gate real money. What matters most here is the FAILURE modes: a missing
 * or broken database must never silently start buying everything, and must
 * never take the engine down either.
 */

const dir = mkdtempSync(join(tmpdir(), "rep-"));
const DB = join(dir, "reputation.sqlite");
process.env.REPUTATION_PATH = DB;

const SPAMMER = "0xAAAa000000000000000000000000000000000001";
const NEWBIE = "0xBBBb000000000000000000000000000000000002";
const WINNER = "0xCCCc000000000000000000000000000000000003";
const PROVEN_1 = "0xDDDd000000000000000000000000000000000011";
const PROVEN_2 = "0xEEEe000000000000000000000000000000000012";
const NOBODY = "0xFFFf000000000000000000000000000000000099";

type Rep = typeof import("../src/lib/sniper/reputation");
type Filters = typeof import("../src/lib/sniper/filters");
type Cfg = typeof import("../src/lib/sniper/config");
let rep: Rep;
let filters: Filters;
let config: Cfg;

before(async () => {
  const db = new DatabaseSync(DB);
  db.exec(`
    CREATE TABLE deployers (addr TEXT PRIMARY KEY, launches INTEGER, graduated INTEGER);
    CREATE TABLE wallets (addr TEXT PRIMARY KEY, early_on INTEGER, graduates INTEGER);
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
  `);
  const d = db.prepare("INSERT INTO deployers VALUES (?,?,?)");
  d.run(SPAMMER.toLowerCase(), 40, 0);
  d.run(NEWBIE.toLowerCase(), 1, 0);
  d.run(WINNER.toLowerCase(), 30, 2);
  const w = db.prepare("INSERT INTO wallets VALUES (?,?,?)");
  w.run(PROVEN_1.toLowerCase(), 5, 2);
  w.run(PROVEN_2.toLowerCase(), 3, 1);
  db.prepare("INSERT INTO meta VALUES (?,?)").run("built_at", "2026-09-04T00:00:00Z");
  db.prepare("INSERT INTO meta VALUES (?,?)").run("tokens", "119600");
  db.close();

  rep = await import("../src/lib/sniper/reputation");
  filters = await import("../src/lib/sniper/filters");
  config = await import("../src/lib/sniper/config");
});

after(() => {
  try {
    rep?.resetReputation();
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* windows keeps the WAL handle; the OS will clean up */
  }
});

// ── the store ────────────────────────────────────────────────────────────────

test("the database is found and reports what it was built from", () => {
  assert.equal(rep.reputationAvailable(), true);
  assert.equal(rep.reputationInfo().tokens, 119600);
});

test("a deployer's record comes back, case-insensitively", () => {
  assert.deepEqual(rep.deployerRecord(SPAMMER), { launches: 40, graduated: 0 });
  assert.deepEqual(rep.deployerRecord(SPAMMER.toLowerCase()), { launches: 40, graduated: 0 });
});

test("an unknown deployer looks like a first-timer, not like a spammer", () => {
  // Defaulting the other way would reject every genuinely new deployer, and
  // first-ever launches are the BEST bucket in the data (1.91%).
  assert.deepEqual(rep.deployerRecord(NOBODY), { launches: 0, graduated: 0 });
});

test("proven buyers are recognised and everyone else is not", () => {
  assert.equal(rep.isProvenBuyer(PROVEN_1), true);
  assert.equal(rep.isProvenBuyer(PROVEN_2.toLowerCase()), true);
  assert.equal(rep.isProvenBuyer(NOBODY), false);
});

test("countProvenBuyers counts distinct wallets only", () => {
  assert.equal(rep.countProvenBuyers([PROVEN_1, PROVEN_2, NOBODY]), 2);
  assert.equal(
    rep.countProvenBuyers([PROVEN_1, PROVEN_1, PROVEN_1.toLowerCase()]),
    1,
    "the same wallet buying repeatedly is one proven buyer, not three",
  );
  assert.equal(rep.countProvenBuyers([]), 0);
});

// ── the filters ──────────────────────────────────────────────────────────────

function snap(over: Record<string, unknown> = {}) {
  return {
    symbol: "GOOD", name: "Good Token", decimals: 18, venue: "curve",
    tradeable: true, quoteIsNative: true, quoteSymbol: "ETH",
    feeBps: 100, creatorTaxBps: 0,
    price: { priceQuote: 1e-9, priceQuoteWad: 1n },
    reserves: { quoteReserve: 2n * 10n ** 18n, tokenReserve: 10n ** 27n },
    graduation: { graduated: false, readyToGraduate: false, progressPct: 10 },
    ...over,
  } as unknown as Parameters<Filters["evaluateLaunch"]>[0]["snapshot"];
}

function input(deployer: string, buyers: string[] = []) {
  return {
    launch: {
      token: "0xtok", curve: "0xcur", deployer,
      pairToken: "0x0000000000000000000000000000000000000000",
      graduationThreshold: 42n,
    },
    snapshot: snap(),
    liquidityEth: 1,
    otherBuys: 10,
    buyVelocity: 1,
    buyers,
  };
}
const cfg = (over: Record<string, unknown> = {}) =>
  ({ ...config.DEFAULT_CONFIG, minLiquidityEth: 0.05, minOtherBuys: 3, ...over }) as Parameters<
    Filters["evaluateLaunch"]
  >[1];

test("a serial deployer with no graduate is rejected", () => {
  const v = filters.evaluateLaunch(input(SPAMMER), cfg({ maxDeployerDudLaunches: 20 }));
  assert.equal(v.buy, false);
  assert.match(v.reason, /40 prior launches/);
});

test("a first-time deployer is allowed through", () => {
  assert.equal(filters.evaluateLaunch(input(NEWBIE), cfg({ maxDeployerDudLaunches: 20 })).buy, true);
});

test("many launches are fine as long as one graduated", () => {
  // 30 launches but 2 graduates: the filter targets duds, not volume. Past
  // success carries no signal either, so this must not become a whitelist.
  assert.equal(filters.evaluateLaunch(input(WINNER), cfg({ maxDeployerDudLaunches: 20 })).buy, true);
});

test("the threshold is respected, not hardcoded", () => {
  assert.equal(filters.evaluateLaunch(input(SPAMMER), cfg({ maxDeployerDudLaunches: 50 })).buy, true);
  assert.equal(filters.evaluateLaunch(input(SPAMMER), cfg({ maxDeployerDudLaunches: 40 })).buy, false);
});

test("null disables the deployer filter entirely", () => {
  assert.equal(filters.evaluateLaunch(input(SPAMMER), cfg({ maxDeployerDudLaunches: null })).buy, true);
});

test("minProvenBuyers rejects a curve backed by nobody with a track record", () => {
  const v = filters.evaluateLaunch(input(NEWBIE, [NOBODY, NOBODY]), cfg({ minProvenBuyers: 2 }));
  assert.equal(v.buy, false);
  assert.match(v.reason, /0 proven buyers/);
});

test("minProvenBuyers passes when enough proven wallets are in", () => {
  assert.equal(
    filters.evaluateLaunch(input(NEWBIE, [PROVEN_1, PROVEN_2, NOBODY]), cfg({ minProvenBuyers: 2 })).buy,
    true,
  );
});

test("one proven wallet buying twice does not satisfy a requirement of two", () => {
  const v = filters.evaluateLaunch(input(NEWBIE, [PROVEN_1, PROVEN_1]), cfg({ minProvenBuyers: 2 }));
  assert.equal(v.buy, false, "otherwise a single wallet could fake a crowd");
});

test("0 disables the proven-buyer filter", () => {
  assert.equal(filters.evaluateLaunch(input(NEWBIE, []), cfg({ minProvenBuyers: 0 })).buy, true);
});

test("SAFETY: asking for proven buyers with no database REFUSES rather than buys", () => {
  // The dangerous failure is the opposite: a filter that silently no-ops when
  // its data is missing turns a deliberate restriction into buying everything.
  rep.resetReputation();
  const saved = process.env.REPUTATION_PATH;
  process.env.REPUTATION_PATH = join(dir, "does-not-exist.sqlite");
  try {
    // Re-import under the new path: the module caches its handle on globalThis.
    const v = filters.evaluateLaunch(input(NEWBIE, [PROVEN_1, PROVEN_2]), cfg({ minProvenBuyers: 2 }));
    assert.equal(v.buy, false);
    assert.match(v.reason, /reputation database/);
  } finally {
    process.env.REPUTATION_PATH = saved;
    rep.resetReputation();
  }
});
