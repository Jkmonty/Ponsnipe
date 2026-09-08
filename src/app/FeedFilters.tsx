"use client";

/**
 * The filter panel, in the feed's own header.
 *
 * Laid out as one column of switches and one grid of min/max pairs, because
 * that is the shape of the data: a handful of yes/no facts about a launch, and
 * a longer list of numbers that have a floor and a ceiling. Grouping them any
 * other way makes the panel look like more than it is.
 */
import {
  DEFAULT_FILTERS,
  activeCount,
  type Filters,
  type Range,
} from "./filterRules";

function Toggle({
  label,
  hint,
  on,
  onChange,
}: {
  label: string;
  hint: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="ff-toggle" title={hint}>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Pair({
  label,
  unit,
  value,
  onChange,
}: {
  label: string;
  unit?: string;
  value: Range;
  onChange: (r: Range) => void;
}) {
  return (
    <div className="ff-row">
      <span className="ff-label">
        {label}
        {unit ? <i>{unit}</i> : null}
      </span>
      <input
        className="input ff-in"
        inputMode="decimal"
        placeholder="min"
        value={value.min}
        onChange={(e) => onChange({ ...value, min: e.target.value })}
      />
      <input
        className="input ff-in"
        inputMode="decimal"
        placeholder="max"
        value={value.max}
        onChange={(e) => onChange({ ...value, max: e.target.value })}
      />
    </div>
  );
}

export default function FeedFilters({
  filters,
  onChange,
  matched,
  total,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  matched: number;
  total: number;
}) {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => onChange({ ...filters, [k]: v });
  const n = activeCount(filters);

  return (
    <div className="ff">
      <div className="ff-head">
        <span className="ff-count">
          {n === 0 ? "No filters" : `${matched} of ${total} match`}
        </span>
        {n > 0 && (
          <button className="linkish" onClick={() => onChange(DEFAULT_FILTERS)}>
            clear all
          </button>
        )}
      </div>

      <div className="ff-toggles">
        <Toggle
          label="Hide bundled"
          hint="one operator holding several wallets to fake a crowd"
          on={filters.noBundled}
          onChange={(v) => set("noBundled", v)}
        />
        <Toggle
          label="Hide dev sold"
          hint="the deployer has already sold some of their own"
          on={filters.noDevSold}
          onChange={(v) => set("noDevSold", v)}
        />
        <Toggle
          label="ETH-priced only"
          hint="over half of pons is priced in tokenised stocks, which need a swap first"
          on={filters.ethOnly}
          onChange={(v) => set("ethOnly", v)}
        />
        <Toggle
          label="Has a link"
          hint="the launch published an X or Telegram link"
          on={filters.hasSocials}
          onChange={(v) => set("hasSocials", v)}
        />
        <Toggle
          label="Traded at least once"
          hint="about half of all launches never trade at all"
          on={filters.tradedOnly}
          onChange={(v) => set("tradedOnly", v)}
        />
      </div>

      <div className="ff-grid">
        <Pair label="Age" unit="min" value={filters.ageMin} onChange={(r) => set("ageMin", r)} />
        <Pair label="Market cap" unit="$k" value={filters.mcapUsd} onChange={(r) => set("mcapUsd", r)} />
        <Pair label="Volume" unit="$k" value={filters.volumeUsd} onChange={(r) => set("volumeUsd", r)} />
        <Pair label="Liquidity" unit="$k" value={filters.liquidityUsd} onChange={(r) => set("liquidityUsd", r)} />
        <Pair label="Holders" value={filters.holders} onChange={(r) => set("holders", r)} />
        <Pair label="Trades" value={filters.trades} onChange={(r) => set("trades", r)} />
        <Pair label="Buys" value={filters.buys} onChange={(r) => set("buys", r)} />
        <Pair label="Sells" value={filters.sells} onChange={(r) => set("sells", r)} />
        <Pair label="To graduation" unit="%" value={filters.progressPct} onChange={(r) => set("progressPct", r)} />
        <Pair label="Top 10 hold" unit="%" value={filters.top10Pct} onChange={(r) => set("top10Pct", r)} />
        <Pair label="Dev holds" unit="%" value={filters.devHoldPct} onChange={(r) => set("devHoldPct", r)} />
        <Pair label="Dev launches" value={filters.devLaunches} onChange={(r) => set("devLaunches", r)} />
        <Pair label="Snipers" value={filters.snipers} onChange={(r) => set("snipers", r)} />
        <Pair label="Bundled wallets" value={filters.bundled} onChange={(r) => set("bundled", r)} />
      </div>

      {/*
        Said plainly, because the alternative is a trader assuming a check was
        run that never was. Everything above is measured by this app; the
        fields other terminals show and this one does not are not hidden, they
        are absent.
      */}
      <p className="ff-note">
        Filters apply to the newest 250 launches held in the feed, not the whole
        chain. Contract audits — honeypot, mint authority, LP burn — are not
        measured here, so there is nothing to filter on.
      </p>
    </div>
  );
}
