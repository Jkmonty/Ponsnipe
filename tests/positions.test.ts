import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the store at a throwaway database BEFORE the db module is loaded.
// The import has to be deferred for that to work — a static import would be
// hoisted above this assignment and pick up the real path.
const dir = mkdtempSync(join(tmpdir(), "pos-"));
process.env.DATABASE_PATH = join(dir, "t.sqlite");
process.on("exit", () => {
  // Windows keeps the sqlite WAL handle open until the process actually dies,
  // so this can EPERM. It's a temp dir either way — never fail the run over it.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS will clean it up */
  }
});

type Mod = typeof import("../src/lib/db/positions");
let createPosition: Mod["createPosition"];
let getPosition: Mod["getPosition"];
let listOpenPositions: Mod["listOpenPositions"];
let listPositions: Mod["listPositions"];
let updatePosition: Mod["updatePosition"];
let claimForClosing: Mod["claimForClosing"];
let countOpenBySource: Mod["countOpenBySource"];
let unrealisedPnlPct: Mod["unrealisedPnlPct"];

before(async () => {
  ({
    createPosition,
    getPosition,
    listOpenPositions,
    listPositions,
    updatePosition,
    claimForClosing,
    countOpenBySource,
    unrealisedPnlPct,
  } = await import("../src/lib/db/positions"));
});

const ADDR = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa" as const;
let n = 0;
function make(over: Record<string, unknown> = {}) {
  n++;
  return createPosition({
    tokenAddress: ADDR, tokenSymbol: `T${n}`, tokenDecimals: 18,
    curveAddress: ADDR, pairToken: "0x0000000000000000000000000000000000000000",
    quoteSymbol: "ETH", quoteDecimals: 18, feeBps: 100, creatorTaxBps: 0,
    quoteInWei: 10n ** 16n, tokensHeldWei: 10n ** 21n, entryPrice: 1,
    buyTx: "0xbuy", takeProfitPct: 50, stopLossPct: 25, trailingStopPct: null,
    slippageBps: 300,
    ...over,
  } as Parameters<typeof createPosition>[0]);
}

test("a new position starts open with its targets and defaults recorded", () => {
  const p = make();
  assert.equal(p.status, "open");
  assert.equal(p.take_profit_pct, 50);
  assert.equal(p.stop_loss_pct, 25);
  assert.equal(p.source, "manual", "source defaults to manual");
  assert.equal(p.sell_attempts, 0);
  assert.equal(p.peak_price, p.entry_price, "peak starts at entry");
  assert.equal(p.tokens_held_wei, (10n ** 21n).toString());
});

test("addresses are stored lowercased so lookups are consistent", () => {
  const p = make();
  assert.equal(p.token_address, ADDR.toLowerCase());
  assert.equal(p.curve_address, ADDR.toLowerCase());
});

test("DOUBLE-SELL GUARD: only the first claim wins", () => {
  const p = make();
  assert.equal(claimForClosing(p.id), true, "first claim takes it");
  assert.equal(claimForClosing(p.id), false, "second claim must be refused");
  assert.equal(claimForClosing(p.id), false);
  assert.equal(getPosition(p.id)!.status, "closing");
});

test("DOUBLE-SELL GUARD: a closed or failed position cannot be re-claimed", () => {
  for (const status of ["closed", "failed", "cancelled"] as const) {
    const p = make();
    updatePosition(p.id, { status });
    assert.equal(claimForClosing(p.id), false, `${status} must not be claimable`);
  }
});

test("a re-armed position can be claimed again (the retry path)", () => {
  // A failed sell returns the position to `open` so the monitor retries.
  const p = make();
  assert.equal(claimForClosing(p.id), true);
  updatePosition(p.id, { status: "open", sell_attempts: 1 });
  assert.equal(claimForClosing(p.id), true, "retry must be able to claim again");
});

test("claiming a position that does not exist is refused, not thrown", () => {
  assert.equal(claimForClosing("no-such-id"), false);
});

test("listOpenPositions includes closing (so stuck ones can be reaped) but not closed", () => {
  const open = make();
  const closing = make();
  claimForClosing(closing.id);
  const closed = make();
  updatePosition(closed.id, { status: "closed" });

  const ids = new Set(listOpenPositions().map((r) => r.id));
  assert.ok(ids.has(open.id), "open included");
  assert.ok(ids.has(closing.id), "closing included — the reaper needs to see it");
  assert.ok(!ids.has(closed.id), "closed excluded");
});

test("updatePosition writes only what it is given and bumps updated_at", async () => {
  const p = make();
  await new Promise((r) => setTimeout(r, 5));
  updatePosition(p.id, { last_price: 2.5 });
  const after = getPosition(p.id)!;
  assert.equal(after.last_price, 2.5);
  assert.equal(after.take_profit_pct, 50, "untouched fields must survive");
  assert.notEqual(after.updated_at, p.updated_at);
});

test("updatePosition with no fields is a no-op rather than invalid SQL", () => {
  const p = make();
  updatePosition(p.id, {});
  assert.equal(getPosition(p.id)!.status, "open");
});

test("null clears a field (used to wipe a stale error on a successful sell)", () => {
  const p = make();
  updatePosition(p.id, { error: "something failed" });
  assert.equal(getPosition(p.id)!.error, "something failed");
  updatePosition(p.id, { error: null });
  assert.equal(getPosition(p.id)!.error, null);
});

test("countOpenBySource backs the sniper's concurrency cap", () => {
  const before = countOpenBySource("sniper");
  const a = make({ source: "sniper" });
  make({ source: "sniper" });
  make({ source: "manual" });
  assert.equal(countOpenBySource("sniper"), before + 2, "manual must not count");

  updatePosition(a.id, { status: "closed" });
  assert.equal(countOpenBySource("sniper"), before + 1, "closed frees a slot");

  const b = make({ source: "sniper" });
  claimForClosing(b.id);
  assert.equal(
    countOpenBySource("sniper"),
    before + 2,
    "a position mid-sell still occupies its slot",
  );
});

test("unrealisedPnlPct is signed and finite", () => {
  const p = make();
  assert.equal(unrealisedPnlPct(p, 1.5), 50);
  assert.equal(unrealisedPnlPct(p, 0.5), -50);
  assert.equal(unrealisedPnlPct(p, 1), 0);
  assert.equal(unrealisedPnlPct({ ...p, entry_price: 0 }, 5), 0, "no divide-by-zero");
});

test("getPosition returns undefined for an unknown id", () => {
  assert.equal(getPosition("nope"), undefined);
});

test("listPositions can filter by status", () => {
  const p = make();
  updatePosition(p.id, { status: "cancelled" });
  const cancelled = listPositions("cancelled");
  assert.ok(cancelled.some((r) => r.id === p.id));
  assert.ok(cancelled.every((r) => r.status === "cancelled"));
});
