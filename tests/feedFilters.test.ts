import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FILTERS,
  activeCount,
  passes,
  type Filterable,
  type Filters,
} from "../src/app/filterRules";

/** A launch that passes everything, so each test only states its own field. */
function row(over: Partial<Filterable> = {}): Filterable {
  return {
    quoteSymbol: "ETH",
    ageMinutes: 5,
    trades: 20,
    buys: 15,
    sells: 5,
    holders: 12,
    progressPct: 8,
    devHoldRate: 0.03,
    devSold: false,
    devLaunches: 1,
    top10Rate: 0.4,
    mcapUsd: 20_000,
    volumeUsd: 9_000,
    liquidityUsd: 4_000,
    socials: "https://x.com/thing",
    snipers: 1,
    bundled: 0,
    ...over,
  };
}

function f(over: Partial<Filters> = {}): Filters {
  return { ...DEFAULT_FILTERS, ...over };
}

test("no filters set lets everything through", () => {
  assert.equal(activeCount(DEFAULT_FILTERS), 0);
  assert.equal(passes(row({ devSold: true, bundled: 9, quoteSymbol: "NVDA" }), DEFAULT_FILTERS), true);
});

test("the badge counts switches and ranges alike", () => {
  assert.equal(activeCount(f({ ethOnly: true })), 1);
  assert.equal(activeCount(f({ ethOnly: true, holders: { min: "5", max: "" } })), 2);
  // A pair with only a ceiling still counts; blanks and spaces do not.
  assert.equal(activeCount(f({ holders: { min: "", max: "50" } })), 1);
  assert.equal(activeCount(f({ holders: { min: "  ", max: "" } })), 0);
});

test("switches reject what they say they reject", () => {
  assert.equal(passes(row({ bundled: 3 }), f({ noBundled: true })), false);
  assert.equal(passes(row({ bundled: 1 }), f({ noBundled: true })), true);
  assert.equal(passes(row({ devSold: true }), f({ noDevSold: true })), false);
  assert.equal(passes(row({ quoteSymbol: "NVDA" }), f({ ethOnly: true })), false);
  assert.equal(passes(row({ quoteSymbol: "eth" }), f({ ethOnly: true })), true);
  assert.equal(passes(row({ socials: "" }), f({ hasSocials: true })), false);
  assert.equal(passes(row({ trades: 0 }), f({ tradedOnly: true })), false);
});

test("money is typed in thousands", () => {
  // "5" means $5k, so a $20k coin clears a floor of 5 and fails one of 50.
  assert.equal(passes(row({ mcapUsd: 20_000 }), f({ mcapUsd: { min: "5", max: "" } })), true);
  assert.equal(passes(row({ mcapUsd: 20_000 }), f({ mcapUsd: { min: "50", max: "" } })), false);
  assert.equal(passes(row({ volumeUsd: 9_000 }), f({ volumeUsd: { min: "", max: "10" } })), true);
});

test("rates are typed as percentages", () => {
  assert.equal(passes(row({ top10Rate: 0.4 }), f({ top10Pct: { min: "", max: "50" } })), true);
  assert.equal(passes(row({ top10Rate: 0.6 }), f({ top10Pct: { min: "", max: "50" } })), false);
  assert.equal(passes(row({ devHoldRate: 0.09 }), f({ devHoldPct: { min: "10", max: "" } })), false);
});

test("an unmeasured field fails a bounded range rather than reading as zero", () => {
  // The alternative would quietly show every unmeasured launch under any
  // ceiling, which is exactly the set a trader filtering on liquidity is
  // trying to avoid.
  assert.equal(passes(row({ liquidityUsd: null }), f({ liquidityUsd: { min: "", max: "100" } })), false);
  assert.equal(passes(row({ liquidityUsd: null }), f({ liquidityUsd: { min: "1", max: "" } })), false);
  // With no bound on that field it is not consulted at all.
  assert.equal(passes(row({ liquidityUsd: null }), f({ holders: { min: "1", max: "" } })), true);
});

test("both bounds are inclusive", () => {
  assert.equal(passes(row({ holders: 12 }), f({ holders: { min: "12", max: "12" } })), true);
  assert.equal(passes(row({ holders: 12 }), f({ holders: { min: "13", max: "" } })), false);
  assert.equal(passes(row({ holders: 12 }), f({ holders: { min: "", max: "11" } })), false);
});

test("junk in a bound is ignored, not treated as zero", () => {
  assert.equal(passes(row({ holders: 12 }), f({ holders: { min: "abc", max: "" } })), true);
});
