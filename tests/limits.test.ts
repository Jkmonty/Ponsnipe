import { test } from "node:test";
import assert from "node:assert/strict";
import { capText, within } from "../src/app/limits";

test("a cap of zero is no cap", () => {
  // The point of the change: "unlimited" had to be expressible, because the
  // alternative was typing a number big enough to hope it never bound.
  assert.equal(within(1_000_000, 0), true);
  assert.equal(capText(0), "no limit");
});

test("a real cap still binds", () => {
  assert.equal(within(0.04, 0.05), true);
  assert.equal(within(0.05, 0.05), true, "exactly at the cap is allowed");
  assert.equal(within(0.06, 0.05), false);
  assert.equal(capText(0.05), "0.05 ETH");
});

test("nonsense in the field cannot quietly become a cap of zero-ish", () => {
  // A blank or unparseable field arrives as NaN. Treating that as a cap would
  // refuse every trade; treating it as no cap is the honest reading of "unset".
  for (const bad of [NaN, Infinity, -1]) {
    assert.equal(within(999, bad), true, String(bad));
    assert.equal(capText(bad), "no limit", String(bad));
  }
});
