import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getAmountOut,
  quoteBuy,
  quoteSell,
  priceFromReserves,
  applySlippage,
} from "../src/lib/pons/pricing";

const E = (n: string) => BigInt(n);
const ONE = 10n ** 18n;

test("getAmountOut matches the Solidity constant-product formula", () => {
  // amountInWithFee = in * (10000 - feeBps)
  // out = (amountInWithFee * reserveOut) / (reserveIn * 10000 + amountInWithFee)
  const amountIn = ONE;
  const rIn = 10n * ONE;
  const rOut = 1000n * ONE;
  const withFee = amountIn * 10_000n;
  const expected = (withFee * rOut) / (rIn * 10_000n + withFee);
  assert.equal(getAmountOut(amountIn, rIn, rOut, 0n), expected);
});

test("getAmountOut applies the fee to the INPUT leg", () => {
  const noFee = getAmountOut(ONE, 10n * ONE, 1000n * ONE, 0n);
  const withFee = getAmountOut(ONE, 10n * ONE, 1000n * ONE, 100n);
  assert.ok(withFee < noFee, "a fee must reduce output");
  // 1% fee on input should cost slightly under 1% of output (curve is convex)
  const ratio = Number(withFee) / Number(noFee);
  assert.ok(ratio > 0.985 && ratio < 1.0, `unexpected fee impact ratio ${ratio}`);
});

test("getAmountOut is safe on degenerate reserves", () => {
  assert.equal(getAmountOut(0n, ONE, ONE, 0n), 0n);
  assert.equal(getAmountOut(ONE, 0n, ONE, 0n), 0n);
  assert.equal(getAmountOut(ONE, ONE, 0n, 0n), 0n);
});

test("quoteBuy takes fee AND creator tax off the input before the curve", () => {
  const reserves = { quoteReserve: 2n * ONE, tokenReserve: 1_000_000n * ONE };
  const quoteIn = ONE / 100n; // 0.01 ETH
  const q = quoteBuy(quoteIn, reserves, 100n, 200n); // 1% fee + 2% tax

  assert.equal(q.fee, (quoteIn * 100n) / 10_000n);
  assert.equal(q.tax, (quoteIn * 200n) / 10_000n);
  assert.equal(q.netQuoteIn, quoteIn - q.fee - q.tax);
  // tokensOut must be priced off the NET amount, not the gross
  assert.equal(
    q.tokensOut,
    getAmountOut(q.netQuoteIn, reserves.quoteReserve, reserves.tokenReserve, 0n),
  );
});

test("quoteSell takes fee AND tax off the OUTPUT leg", () => {
  const reserves = { quoteReserve: 2n * ONE, tokenReserve: 1_000_000n * ONE };
  const tokensIn = 1000n * ONE;
  const s = quoteSell(tokensIn, reserves, 100n, 200n);

  const gross = getAmountOut(tokensIn, reserves.tokenReserve, reserves.quoteReserve, 0n);
  assert.equal(s.grossQuoteOut, gross);
  assert.equal(s.fee, (gross * 100n) / 10_000n);
  assert.equal(s.tax, (gross * 200n) / 10_000n);
  assert.equal(s.quoteOut, gross - s.fee - s.tax);
});

test("an immediate buy→sell round trip loses roughly fee+tax on both legs", () => {
  const reserves = { quoteReserve: 2n * ONE, tokenReserve: 1_000_000n * ONE };
  const inAmt = ONE / 1000n;
  const b = quoteBuy(inAmt, reserves, 100n, 0n);
  const after = {
    quoteReserve: reserves.quoteReserve + b.netQuoteIn,
    tokenReserve: reserves.tokenReserve - b.tokensOut,
  };
  const s = quoteSell(b.tokensOut, after, 100n, 0n);
  const lossPct = (1 - Number(s.quoteOut) / Number(inAmt)) * 100;
  // two 1% legs plus a little price impact
  assert.ok(lossPct > 1.9 && lossPct < 4, `round-trip loss ${lossPct.toFixed(2)}% out of range`);
});

test("priceFromReserves handles decimals and is the inverse of reserve ratio", () => {
  // 2 ETH against 1,000,000 whole tokens => 0.000002 ETH per token
  const p = priceFromReserves(
    { quoteReserve: 2n * ONE, tokenReserve: 1_000_000n * ONE },
    18,
    18,
  );
  assert.ok(Math.abs(p.priceQuote - 0.000002) < 1e-12, `got ${p.priceQuote}`);

  // a 6-decimal quote asset must not change the human-readable price
  const p6 = priceFromReserves(
    { quoteReserve: 2n * 10n ** 6n, tokenReserve: 1_000_000n * ONE },
    18,
    6,
  );
  assert.ok(Math.abs(p6.priceQuote - 0.000002) < 1e-12, `got ${p6.priceQuote}`);
});

test("priceFromReserves is zero on empty reserves rather than NaN/Infinity", () => {
  assert.equal(priceFromReserves({ quoteReserve: 0n, tokenReserve: ONE }, 18, 18).priceQuote, 0);
  assert.equal(priceFromReserves({ quoteReserve: ONE, tokenReserve: 0n }, 18, 18).priceQuote, 0);
});

test("applySlippage reduces the floor and never goes negative", () => {
  assert.equal(applySlippage(10_000n, 0), 10_000n);
  assert.equal(applySlippage(10_000n, 300), 9_700n); // 3%
  assert.equal(applySlippage(10_000n, 10_000), 100n); // clamped to 99%, not 0/negative
  // A slippage over 100% would otherwise produce a NEGATIVE minimum-out, which
  // on-chain means "accept literally any fill".
  assert.ok(applySlippage(10_000n, 50_000) >= 0n);
  assert.ok(applySlippage(10_000n, -50) <= 10_000n);
});

test("E helper unused guard", () => {
  assert.equal(E("1"), 1n);
});
