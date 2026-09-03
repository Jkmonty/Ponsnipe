import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateExit, graduationProgressPct } from "../src/lib/engine/rules";
import type { PositionRow } from "../src/lib/db/positions";

/** A position bought at price 1.0 with no rules armed. */
function pos(over: Partial<PositionRow> = {}): PositionRow {
  return {
    id: "t", status: "open", token_address: "0x", token_symbol: "T",
    token_decimals: 18, curve_address: "0x", pair_token: "0x0",
    quote_symbol: "ETH", quote_decimals: 18, fee_bps: 100, creator_tax_bps: 0,
    quote_in_wei: "10000000000000000", tokens_held_wei: "1000", entry_price: 1,
    buy_tx: null, source: "manual",
    take_profit_pct: null, stop_loss_pct: null, trailing_stop_pct: null,
    graduation_exit_pct: null, graduation_threshold_wei: null, slippage_bps: 300,
    peak_price: 1, last_price: 1, last_checked_at: null,
    sell_attempts: 0, last_dry_run_at: null,
    exit_price: null, quote_out_wei: null, realised_pnl_pct: null,
    sell_tx: null, close_reason: null, error: null,
    created_at: "", updated_at: "",
    ...over,
  };
}

test("no rules armed never exits", () => {
  for (const price of [0.01, 0.5, 1, 2, 100]) {
    assert.equal(evaluateExit(pos(), { price }).shouldExit, false);
  }
});

test("take-profit fires at or above the target, not below", () => {
  const p = pos({ take_profit_pct: 50 });
  assert.equal(evaluateExit(p, { price: 1.49 }).shouldExit, false);
  const hit = evaluateExit(p, { price: 1.5 });
  assert.equal(hit.shouldExit, true);
  assert.equal(hit.reason, "take_profit");
});

test("stop-loss fires at or below the target", () => {
  const p = pos({ stop_loss_pct: 20 });
  assert.equal(evaluateExit(p, { price: 0.81 }).shouldExit, false);
  const hit = evaluateExit(p, { price: 0.8 });
  assert.equal(hit.shouldExit, true);
  assert.equal(hit.reason, "stop_loss");
});

test("stop-loss is stored positive but compared as a drop", () => {
  // a negative value in the column must behave the same way
  const hit = evaluateExit(pos({ stop_loss_pct: -20 }), { price: 0.79 });
  assert.equal(hit.reason, "stop_loss");
});

test("trailing stop measures from the PEAK, not from entry", () => {
  const p = pos({ trailing_stop_pct: 20, peak_price: 2 });
  // 1.65 is +65% vs entry but -17.5% from the peak: must NOT exit
  assert.equal(evaluateExit(p, { price: 1.65 }).shouldExit, false);
  // 1.6 is -20% from the peak: exits, despite still being up on entry
  const hit = evaluateExit(p, { price: 1.6 });
  assert.equal(hit.shouldExit, true);
  assert.equal(hit.reason, "trailing_stop");
});

test("peak is carried forward, never regressed", () => {
  const d1 = evaluateExit(pos({ peak_price: 2 }), { price: 1.0 });
  assert.equal(d1.peakPrice, 2, "a lower price must not lower the peak");
  const d2 = evaluateExit(pos({ peak_price: 2 }), { price: 3.0 });
  assert.equal(d2.peakPrice, 3, "a higher price must raise the peak");
});

test("graduation exit fires on curve progress regardless of PnL", () => {
  const p = pos({ graduation_exit_pct: 92 });
  assert.equal(evaluateExit(p, { price: 1, graduationPct: 91.9 }).shouldExit, false);
  const hit = evaluateExit(p, { price: 1, graduationPct: 92 });
  assert.equal(hit.shouldExit, true);
  assert.equal(hit.reason, "graduation_exit");
});

test("graduation exit is inert when progress is unknown", () => {
  const p = pos({ graduation_exit_pct: 92 });
  assert.equal(evaluateExit(p, { price: 1 }).shouldExit, false);
  assert.equal(evaluateExit(p, { price: 1, graduationPct: NaN }).shouldExit, false);
});

test("PRECEDENCE: stop-loss beats graduation exit", () => {
  // Both conditions true at once — capital preservation must win.
  const p = pos({ stop_loss_pct: 20, graduation_exit_pct: 50 });
  const d = evaluateExit(p, { price: 0.5, graduationPct: 99 });
  assert.equal(d.reason, "stop_loss");
});

test("PRECEDENCE: graduation exit beats take-profit", () => {
  // Past graduation the curve stops accepting sells, so getting out must
  // outrank waiting for a target that may never be reachable.
  const p = pos({ take_profit_pct: 50, graduation_exit_pct: 92 });
  const d = evaluateExit(p, { price: 2, graduationPct: 95 });
  assert.equal(d.reason, "graduation_exit");
});

test("pnl is reported on every decision, exit or not", () => {
  assert.equal(evaluateExit(pos(), { price: 1.5 }).pnlPct, 50);
  assert.equal(evaluateExit(pos(), { price: 0.5 }).pnlPct, -50);
});

test("a zero entry price cannot produce Infinity/NaN PnL", () => {
  const d = evaluateExit(pos({ entry_price: 0 }), { price: 5 });
  assert.equal(Number.isFinite(d.pnlPct), true);
});

test("legacy number argument still means price", () => {
  const d = evaluateExit(pos({ take_profit_pct: 50 }), 1.5);
  assert.equal(d.reason, "take_profit");
});

test("graduationProgressPct handles missing/zero thresholds", () => {
  assert.equal(graduationProgressPct(10n, null), undefined);
  assert.equal(graduationProgressPct(10n, "0"), undefined);
  assert.equal(graduationProgressPct(10n, "not-a-number"), undefined);
  assert.equal(graduationProgressPct(21n, "42"), 50);
  assert.equal(graduationProgressPct(100n, "42"), 100, "clamped at 100");
});
