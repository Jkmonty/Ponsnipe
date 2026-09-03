import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEventDelta } from "../src/lib/engine/monitor";
import { quoteBuy, quoteSell, priceFromReserves } from "../src/lib/pons/pricing";

const ONE = 10n ** 18n;
const start = () => ({ quoteReserve: 2n * ONE, tokenReserve: 1_000_000n * ONE });

/**
 * These guard the FAST PATH. When a trade lands on a curve we hold, the monitor
 * updates reserves from the event's own fields and decides whether to sell
 * without reading the chain. A sign error here silently prices every fast exit
 * wrongly — and the fast path is exactly the one a dump takes.
 */

test("CurveBuy adds the NET quote (fee and tax are creamed off) and removes tokens", () => {
  const r = start();
  const next = applyEventDelta(r, "CurveBuy", {
    quoteIn: ONE, fee: ONE / 100n, tax: ONE / 50n, tokensOut: 1000n * ONE,
  });
  // getReserves() = phantom + trackedQuote - feeBalance - taxBalance, so the
  // curve's price-relevant quote only grows by quoteIn - fee - tax.
  assert.equal(next.quoteReserve, r.quoteReserve + ONE - ONE / 100n - ONE / 50n);
  assert.equal(next.tokenReserve, r.tokenReserve - 1000n * ONE);
});

test("CurveSell removes the GROSS quote (out + fee + tax) and returns tokens", () => {
  const r = start();
  const next = applyEventDelta(r, "CurveSell", {
    quoteOut: ONE / 2n, fee: ONE / 100n, tax: ONE / 50n, tokensIn: 1000n * ONE,
  });
  assert.equal(next.quoteReserve, r.quoteReserve - (ONE / 2n + ONE / 100n + ONE / 50n));
  assert.equal(next.tokenReserve, r.tokenReserve + 1000n * ONE);
});

test("a buy raises the price and a sell lowers it", () => {
  const r = start();
  const p0 = priceFromReserves(r, 18, 18).priceQuote;
  const afterBuy = applyEventDelta(r, "CurveBuy", {
    quoteIn: ONE, fee: 0n, tax: 0n, tokensOut: 1000n * ONE,
  });
  const afterSell = applyEventDelta(r, "CurveSell", {
    quoteOut: ONE / 2n, fee: 0n, tax: 0n, tokensIn: 1000n * ONE,
  });
  assert.ok(priceFromReserves(afterBuy, 18, 18).priceQuote > p0, "buy must raise price");
  assert.ok(priceFromReserves(afterSell, 18, 18).priceQuote < p0, "sell must lower price");
});

test("FAST PATH AGREES WITH THE QUOTE PATH — a buy we simulate lands where the event says", () => {
  // quoteBuy (used to size an order) and applyEventDelta (used to track the
  // curve from logs) are independent implementations of the same contract
  // maths. If they disagree, the fast path exits on a wrong price.
  const r = start();
  const quoteIn = ONE / 100n;
  const q = quoteBuy(quoteIn, r, 100n, 200n);

  const viaEvent = applyEventDelta(r, "CurveBuy", {
    quoteIn, fee: q.fee, tax: q.tax, tokensOut: q.tokensOut,
  });
  const viaMaths = {
    quoteReserve: r.quoteReserve + q.netQuoteIn,
    tokenReserve: r.tokenReserve - q.tokensOut,
  };
  assert.deepEqual(viaEvent, viaMaths);
});

test("FAST PATH AGREES WITH THE QUOTE PATH — sell side", () => {
  const r = start();
  const tokensIn = 1000n * ONE;
  const s = quoteSell(tokensIn, r, 100n, 200n);

  const viaEvent = applyEventDelta(r, "CurveSell", {
    quoteOut: s.quoteOut, fee: s.fee, tax: s.tax, tokensIn,
  });
  // gross = out + fee + tax, so the reserve drops by exactly the gross
  assert.equal(viaEvent.quoteReserve, r.quoteReserve - s.grossQuoteOut);
  assert.equal(viaEvent.tokenReserve, r.tokenReserve + tokensIn);
});

test("reserves clamp at zero rather than going negative", () => {
  const tiny = { quoteReserve: 10n, tokenReserve: 10n };
  const drained = applyEventDelta(tiny, "CurveSell", {
    quoteOut: 1000n, fee: 0n, tax: 0n, tokensIn: 0n,
  });
  assert.equal(drained.quoteReserve, 0n);

  const emptied = applyEventDelta(tiny, "CurveBuy", {
    quoteIn: 0n, fee: 0n, tax: 0n, tokensOut: 1000n,
  });
  assert.equal(emptied.tokenReserve, 0n);
});

test("a buy whose fees exceed the input cannot shrink the quote reserve", () => {
  const r = start();
  const next = applyEventDelta(r, "CurveBuy", {
    quoteIn: 100n, fee: 90n, tax: 90n, tokensOut: 0n,
  });
  assert.ok(next.quoteReserve >= r.quoteReserve, "a buy must never reduce quote reserves");
});

test("missing event fields are treated as zero, not NaN", () => {
  const r = start();
  const next = applyEventDelta(r, "CurveBuy", {});
  assert.equal(next.quoteReserve, r.quoteReserve);
  assert.equal(next.tokenReserve, r.tokenReserve);
});

test("unknown events are a no-op", () => {
  const r = start();
  assert.deepEqual(applyEventDelta(r, "FeesSwept", { amount: ONE }), r);
  assert.deepEqual(applyEventDelta(r, "", {}), r);
});

test("many deltas compose without drift", () => {
  // 50 alternating trades should leave reserves exactly where arithmetic says.
  let r = start();
  let expectedQuote = r.quoteReserve;
  let expectedToken = r.tokenReserve;
  for (let i = 0; i < 50; i++) {
    r = applyEventDelta(r, "CurveBuy", {
      quoteIn: ONE / 1000n, fee: 0n, tax: 0n, tokensOut: ONE,
    });
    expectedQuote += ONE / 1000n;
    expectedToken -= ONE;
  }
  assert.equal(r.quoteReserve, expectedQuote);
  assert.equal(r.tokenReserve, expectedToken);
});
