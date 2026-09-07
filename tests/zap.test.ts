import { test } from "node:test";
import assert from "node:assert/strict";
import { zapMinOut } from "../src/lib/pons/zap";

/*
 * The zap buys the quote asset a curve is priced in, which is how the roughly
 * half of pons launches quoted in USDG, NVDA and the other tokenised equities
 * become reachable at all. zapMinOut is the floor the swap must clear, so it
 * is the piece that decides whether a bad fill is accepted or reverted.
 */

test("takes the slippage budget off the quote", () => {
  // 800bps = 8%, the sniper's default.
  assert.equal(zapMinOut(1_000_000n, 800), 920_000n);
  assert.equal(zapMinOut(1_000_000n, 0), 1_000_000n);
});

test("rounds down, never up", () => {
  // 999 * 9200 / 10000 = 919.08 -> 919. A floor that rounded up could be set
  // above what the pool will actually pay and revert a good swap.
  assert.equal(zapMinOut(999n, 800), 919n);
});

test("a zero or negative quote floors at zero rather than going negative", () => {
  assert.equal(zapMinOut(0n, 800), 0n);
  assert.equal(zapMinOut(-5n, 800), 0n);
});

test("a nonsense slippage budget cannot disable the floor", () => {
  // Over 100% would make the floor zero and accept ANY fill, which is the
  // expensive direction; below zero would put the floor above the quote and
  // reject every swap. Both are clamped.
  assert.equal(zapMinOut(1_000_000n, 20_000), 0n);
  assert.equal(zapMinOut(1_000_000n, -500), 1_000_000n);
  assert.equal(zapMinOut(1_000_000n, 10_000), 0n);
});

test("survives amounts far larger than this bot will ever trade", () => {
  // 1000 ETH in wei, so a bigint path that silently went through Number would
  // lose precision here.
  const huge = 1_000n * 10n ** 18n;
  assert.equal(zapMinOut(huge, 100), (huge * 9_900n) / 10_000n);
});
