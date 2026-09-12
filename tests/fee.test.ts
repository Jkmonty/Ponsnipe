import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "viem";

/** The split the buy path does, kept here so the arithmetic is pinned. */
function splitAt(ethIn: bigint, bps: number) {
  const fee = (ethIn * BigInt(bps)) / 10_000n;
  return { fee, net: ethIn - fee };
}

test("the fee comes out of the amount, never on top of it", () => {
  // Type 0.01 and 0.01 leaves the wallet. A fee that quietly makes the number
  // bigger is how people find out they were charged.
  const { fee, net } = splitAt(parseEther("0.01"), 100);
  assert.equal(fee + net, parseEther("0.01"));
  assert.equal(fee, parseEther("0.0001"));
});

test("one percent is one percent", () => {
  assert.equal(splitAt(parseEther("1"), 100).fee, parseEther("0.01"));
  assert.equal(splitAt(parseEther("0.5"), 100).fee, parseEther("0.005"));
});

test("zero bps takes nothing and leaves the trade whole", () => {
  const wei = parseEther("0.0137");
  const { fee, net } = splitAt(wei, 0);
  assert.equal(fee, 0n);
  assert.equal(net, wei);
});

test("rounding never invents value", () => {
  // Integer division truncates, so the fee is at most the true share and the
  // trader is never charged a wei more than the rate says.
  for (const amount of [1n, 7n, 99n, 12345n]) {
    const { fee, net } = splitAt(amount, 100);
    assert.equal(fee + net, amount, `conserved at ${amount}`);
    assert.ok(fee * 10_000n <= amount * 100n, `never over the rate at ${amount}`);
  }
});
