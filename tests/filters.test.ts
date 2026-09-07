import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateLaunch, type FilterInput } from "../src/lib/sniper/filters";
import { DEFAULT_CONFIG, sniperConfigSchema, type SniperConfig } from "../src/lib/sniper/config";
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

/* ── ticker watch ──────────────────────────────────────────────────────────
   A named ticker skips the filters that form an OPINION about a launch, and
   none of the ones that protect the wallet. These pin that line down, because
   getting it wrong in either direction is expensive: too loose and a watch
   buys a honeypot, too tight and the feature does not work at all. */

const HIT = { ticker: "GOOD", pinnedDeployer: true, ethAmount: null };

test("a named ticker buys without the other-buyer minimum", () => {
  const c = cfg({ minOtherBuys: 8 });
  // Same launch, no crowd behind it: rejected normally, taken when named.
  assert.equal(evaluateLaunch(input({ otherBuys: 0 }), c).buy, false);
  assert.equal(evaluateLaunch(input({ otherBuys: 0, tickerHit: HIT }), c).buy, true);
});

test("a named ticker skips the liquidity floor and the velocity gate", () => {
  const c = cfg({ minLiquidityEth: 5, minBuyVelocity: 10 });
  assert.equal(evaluateLaunch(input({ liquidityEth: 0.01, buyVelocity: 0 }), c).buy, false);
  assert.equal(
    evaluateLaunch(input({ liquidityEth: 0.01, buyVelocity: 0, tickerHit: HIT }), c).buy,
    true,
  );
});

test("a named ticker skips the name filters that would contradict it", () => {
  // Asking for GOOD by name while an old allow-regex says only /MOON/ should
  // buy GOOD, not sit there rejecting the thing you explicitly asked for.
  const c = cfg({ nameAllowRegex: "MOON", nameDenyRegex: "GOOD" });
  assert.equal(evaluateLaunch(input(), c).buy, false);
  assert.equal(evaluateLaunch(input({ tickerHit: HIT }), c).buy, true);
});

test("a named ticker is STILL blocked by the creator tax cap", () => {
  // The trap case: a 90% creator tax takes the position whatever it is called.
  const c = cfg({ maxCreatorTaxBps: 300 });
  const v = evaluateLaunch(
    input({ snapshot: snap({ creatorTaxBps: 9000 }), tickerHit: HIT }),
    c,
  );
  assert.equal(v.buy, false);
  assert.match(v.reason, /creator tax/);
});

test("a named ticker is STILL blocked by the deployer denylist", () => {
  const c = cfg({ deployerDeny: [DEPLOYER] });
  const v = evaluateLaunch(input({ tickerHit: HIT }), c);
  assert.equal(v.buy, false);
  assert.match(v.reason, /denylist/);
});

test("a named ticker is STILL blocked when the token cannot be traded", () => {
  const c = cfg();
  assert.equal(
    evaluateLaunch(
      input({ snapshot: snap({ tradeable: false, reason: "already graduated" }), tickerHit: HIT }),
      c,
    ).buy,
    false,
  );
  // And a non-ETH quote is still a hard stop: we cannot pay in it.
  assert.equal(
    evaluateLaunch(
      input({ snapshot: snap({ quoteIsNative: false, quoteSymbol: "USDG" }), tickerHit: HIT }),
      c,
    ).buy,
    false,
  );
});

test("an older saved config still loads instead of resetting to defaults", () => {
  // loadSniperConfig falls back to DEFAULT_CONFIG on a parse failure, so a new
  // REQUIRED field would silently wipe a tuned sniper.json. Everything added
  // must default. This parses a config written before the ticker watch existed.
  const old = { ...DEFAULT_CONFIG, minOtherBuys: 9, maxDailySpendEth: 0.5 } as Record<string, unknown>;
  delete old.tickerWatch;
  delete old.tickerDelaySeconds;
  const parsed = sniperConfigSchema.safeParse(old);
  assert.equal(parsed.success, true, "a pre-ticker-watch config must still parse");
  if (parsed.success) {
    assert.equal(parsed.data.minOtherBuys, 9, "existing settings must survive");
    assert.equal(parsed.data.maxDailySpendEth, 0.5);
    assert.deepEqual(parsed.data.tickerWatch, []);
    assert.equal(parsed.data.tickerDelaySeconds, 4);
  }
});

/* ── non-ETH quotes ───────────────────────────────────────────────────────
   Roughly half of pons launches are quoted in USDG or a tokenised equity.
   The sniper refused all of them until the zap existed; now that is a choice,
   and these pin down that it is genuinely a choice in both directions. */

test("a USDG-quoted launch is still refused while the zap is off", () => {
  const v = evaluateLaunch(
    input({ snapshot: snap({ quoteIsNative: false, quoteSymbol: "USDG" }) }),
    cfg({ allowNonEthQuotes: false }),
  );
  assert.equal(v.buy, false);
  assert.match(v.reason, /USDG/);
  // blockedByQuote says the quote asset was the ONLY thing wrong, which is what
  // lets the UI tell "we rejected this" apart from "we cannot reach it yet".
  assert.equal(v.blockedByQuote, true);
});

test("a USDG-quoted launch passes once the zap is allowed", () => {
  const v = evaluateLaunch(
    input({ snapshot: snap({ quoteIsNative: false, quoteSymbol: "USDG" }) }),
    cfg({ allowNonEthQuotes: true }),
  );
  assert.equal(v.buy, true, v.reason);
});

test("allowing non-ETH quotes does not weaken any other filter", () => {
  // The quote gate is the only thing that moves. A launch that would fail on
  // its own merits still fails, whatever it is priced in.
  const c = cfg({ allowNonEthQuotes: true, minOtherBuys: 8 });
  assert.equal(
    evaluateLaunch(
      input({ snapshot: snap({ quoteIsNative: false, quoteSymbol: "NVDA" }), otherBuys: 0 }),
      c,
    ).buy,
    false,
  );
  assert.equal(
    evaluateLaunch(
      input({ snapshot: snap({ quoteIsNative: false, creatorTaxBps: 9000 }) }),
      cfg({ allowNonEthQuotes: true }),
    ).buy,
    false,
  );
});
