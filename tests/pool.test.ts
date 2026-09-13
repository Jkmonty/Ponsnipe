import { test } from "node:test";
import assert from "node:assert/strict";
import { feeWalletAddress, fmtPool } from "../src/lib/pool";

test("no fee wallet means no pool", () => {
  assert.equal(feeWalletAddress(""), null);
  assert.equal(feeWalletAddress(undefined), null);
  assert.equal(feeWalletAddress("   "), null);
});

test("a malformed fee wallet is treated as unset, not as an address", () => {
  assert.equal(feeWalletAddress("0x1234"), null);
  assert.equal(feeWalletAddress("not-an-address"), null);
});

test("a real address is returned trimmed, whatever its case", () => {
  const a = "0x5782bc813be39efb6ca57b16e43ca92f48ffa9a0";
  assert.equal(feeWalletAddress(`  ${a}  `), a);
  // The same test fee.ts applies in the browser: a hex shape, not a checksum.
  assert.equal(feeWalletAddress(a.toUpperCase().replace("0X", "0x")), a.toUpperCase().replace("0X", "0x"));
});

test("the pool is shown to three decimals, never more, never fewer", () => {
  assert.equal(fmtPool(0.41234), "0.412 ETH");
  assert.equal(fmtPool(1), "1.000 ETH");
  assert.equal(fmtPool(0), "0.000 ETH");
  assert.equal(fmtPool(12.3456789), "12.346 ETH");
});
