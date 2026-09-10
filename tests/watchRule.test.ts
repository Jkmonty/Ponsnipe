import { test } from "node:test";
import assert from "node:assert/strict";

/** The parse the watch form does when arming, extracted so it can be pinned. */
const rule = (v: string) => (Number(v) > 0 ? Math.abs(Number(v)) : null);

test("blank, zero and junk all mean no rule", () => {
  // The bug this replaces: a typed 0 armed a take-profit at break-even, which
  // fires the instant a position exists.
  for (const off of ["", "0", "0.0", "   ", "abc", "-5"]) {
    assert.equal(rule(off), null, JSON.stringify(off));
  }
});

test("a real percentage still arms", () => {
  assert.equal(rule("50"), 50);
  assert.equal(rule("2.5"), 2.5);
});
