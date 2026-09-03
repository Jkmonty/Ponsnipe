import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateLaunch, type FilterInput } from "../src/lib/sniper/filters";
import { DEFAULT_CONFIG, type SniperConfig } from "../src/lib/sniper/config";
import type { TokenSnapshot } from "../src/lib/pons/tokens";

const DEPLOYER = "0x1111111111111111111111111111111111111111";

function snap(over: Record<string, unknown> = {}): TokenSnapshot {
  return {
    symbol: "GOOD", name: "Good Token", decimals: 18, venue: "curve",
    tradeable: true, quoteIsNative: true, quoteSymbol: "ETH",
    feeBps: 100, creatorTaxBps: 0,
    price: { priceQuote: 1e-9, priceQuoteWad: 1n },
    reserves: { quoteReserve: 2n * 10n ** 18n, tokenReserve: 10n ** 27n },
    graduation: { graduated: false, readyToGraduate: false, progressPct: 10 },
    ...over,
  } as unknown as TokenSnapshot;
}

function input(over: Partial<FilterInput> = {}): FilterInput {
  return {
    launch: {
      token: "0xtok", curve: "0xcur", deployer: DEPLOYER,
      pairToken: "0x0000000000000000000000000000000000000000",
      graduationThreshold: 42n,
    },
    snapshot: snap(),
    liquidityEth: 1,
    otherBuys: 10,
    buyVelocity: 1,
    ...over,
  };
}

const cfg = (over: Partial<SniperConfig> = {}): SniperConfig => ({
  ...DEFAULT_CONFIG,
  minLiquidityEth: 0.05,
  minOtherBuys: 3,
  maxCreatorTaxBps: 300,
  ...over,
});

test("a clean launch passes", () => {
  const v = evaluateLaunch(input(), cfg());
  assert.equal(v.buy, true, v.reason);
});

test("rejects a non-ETH-quoted launch", () => {
  // ~40-60% of pons launches are quoted against USDG or a stock token, which
  // the bot wallet cannot pay for without a zap.
  const v = evaluateLaunch(
    input({ snapshot: snap({ quoteIsNative: false, quoteSymbol: "USDG" }) }),
    cfg(),
  );
  assert.equal(v.buy, false);
  assert.match(v.reason, /USDG/);
});

test("rejects an untradeable snapshot", () => {
  const v = evaluateLaunch(
    input({ snapshot: snap({ tradeable: false, reason: "already graduated" }) }),
    cfg(),
  );
  assert.equal(v.buy, false);
});

test("rejects creator tax above the cap", () => {
  assert.equal(evaluateLaunch(input({ snapshot: snap({ creatorTaxBps: 301 }) }), cfg()).buy, false);
  assert.equal(evaluateLaunch(input({ snapshot: snap({ creatorTaxBps: 300 }) }), cfg()).buy, true);
});

test("enforces the liquidity band", () => {
  assert.equal(evaluateLaunch(input({ liquidityEth: 0.049 }), cfg()).buy, false);
  assert.equal(evaluateLaunch(input({ liquidityEth: 0.05 }), cfg()).buy, true);
  assert.equal(
    evaluateLaunch(input({ liquidityEth: 10 }), cfg({ maxLiquidityEth: 5 })).buy,
    false,
  );
});

test("enforces minimum other buys", () => {
  assert.equal(evaluateLaunch(input({ otherBuys: 2 }), cfg()).buy, false);
  assert.equal(evaluateLaunch(input({ otherBuys: 3 }), cfg()).buy, true);
});

test("buy velocity is off unless configured", () => {
  assert.equal(evaluateLaunch(input({ buyVelocity: 0 }), cfg()).buy, true);
  assert.equal(
    evaluateLaunch(input({ buyVelocity: 0.1 }), cfg({ minBuyVelocity: 0.5 })).buy,
    false,
  );
  assert.equal(
    evaluateLaunch(input({ buyVelocity: 0.5 }), cfg({ minBuyVelocity: 0.5 })).buy,
    true,
  );
});

test("a missing velocity is treated as zero, not as passing", () => {
  const v = evaluateLaunch(input({ buyVelocity: undefined }), cfg({ minBuyVelocity: 0.5 }));
  assert.equal(v.buy, false);
});

test("deployer denylist always wins", () => {
  const v = evaluateLaunch(input(), cfg({ deployerDeny: [DEPLOYER.toUpperCase()] }));
  assert.equal(v.buy, false, "denylist must be case-insensitive");
});

test("a non-empty allowlist excludes everyone else", () => {
  assert.equal(evaluateLaunch(input(), cfg({ deployerAllow: ["0xother"] })).buy, false);
  assert.equal(evaluateLaunch(input(), cfg({ deployerAllow: [DEPLOYER] })).buy, true);
});

test("skips launches already at the graduation threshold", () => {
  const v = evaluateLaunch(
    input({ snapshot: snap({ graduation: { graduated: false, readyToGraduate: false, progressPct: 96 } }) }),
    cfg(),
  );
  assert.equal(v.buy, false);
});

test("an invalid regex is ignored rather than throwing", () => {
  const v = evaluateLaunch(input(), cfg({ nameAllowRegex: "([unclosed" }));
  assert.equal(v.buy, true);
});

test("name allow/deny regexes match case-insensitively on symbol and name", () => {
  assert.equal(evaluateLaunch(input(), cfg({ nameAllowRegex: "^good" })).buy, true);
  assert.equal(evaluateLaunch(input(), cfg({ nameAllowRegex: "nomatch" })).buy, false);
  assert.equal(evaluateLaunch(input(), cfg({ nameDenyRegex: "GOOD" })).buy, false);
});
