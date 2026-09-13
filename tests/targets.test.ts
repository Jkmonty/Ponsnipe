import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPins, type Target } from "../src/lib/targets";

const t = (symbol: string, launches: number, changePct: number): Target => ({
  symbol,
  launches,
  changePct,
  price: 100,
});

test("pins are the most-used targets, most used first", () => {
  const pins = pickPins([t("AAPL", 3, 1), t("NVDA", 9, 2), t("SPY", 5, -1), t("TSLA", 7, 0.5)]);
  assert.deepEqual(
    pins.map((p) => p.symbol),
    ["NVDA", "TSLA", "SPY"],
  );
});

test("up is the day's move, and flat counts as up", () => {
  const pins = pickPins([t("A", 3, 1.2), t("B", 2, -0.4), t("C", 1, 0)]);
  assert.deepEqual(
    pins.map((p) => p.up),
    [true, false, true],
  );
});

test("fewer targets than pins is fine, and none is none", () => {
  assert.equal(pickPins([t("A", 1, 1)]).length, 1);
  assert.deepEqual(pickPins([]), []);
});

test("n is honoured and the input is not reordered", () => {
  const input = [t("A", 1, 1), t("B", 2, 1)];
  const pins = pickPins(input, 1);
  assert.deepEqual(pins.map((p) => p.symbol), ["B"]);
  assert.deepEqual(input.map((x) => x.symbol), ["A", "B"]);
});
