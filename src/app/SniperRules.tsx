"use client";

/**
 * The rules panel and the log, for the browser sniper.
 *
 * Split out of TradePanel because that file had grown to hold buying, selling,
 * holdings, sell rules and ticker watches, and this is a sixth thing. Nothing
 * here has its own state beyond a fold: everything is read from and written
 * through the sniper hook, so what is on screen and what will actually fire
 * cannot drift apart.
 */
import type { Sniper } from "./useSniper";
import { CollapseButton, useCollapsed } from "./Collapse";

/** A number field that writes straight through to the sniper's config. */
function Num({
  label,
  value,
  suffix,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  suffix?: string;
  onChange: (n: number) => void;
  disabled: boolean;
}) {
  return (
    <label className="field">
      <span>
        {label}
        {suffix ? <i className="muted"> {suffix}</i> : null}
      </span>
      <input
        className="input"
        inputMode="numeric"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    </label>
  );
}

function Check({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <label className={`rule-check${disabled ? " off" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong>{label}</strong>
        <i>{hint}</i>
      </span>
    </label>
  );
}

export default function SniperRules({
  sniper,
  locked,
  onConnect,
}: {
  sniper: Sniper;
  locked: boolean;
  onConnect: () => void;
}) {
  const fold = useCollapsed("rules", true);
  const logFold = useCollapsed("snipelog", true);
  const { cfg, setCfg } = sniper;
  const set = <K extends keyof typeof cfg>(k: K, v: (typeof cfg)[K]) => setCfg({ ...cfg, [k]: v });

  return (
    <>
      <div className={`snipe${fold.collapsed ? " is-collapsed" : ""}`}>
        <div className="card-head">
          <h3 className="shead">Auto-snipe by rule</h3>
          <div className="row" style={{ gap: 8 }}>
            {cfg.enabled && !locked && (
              <span className="chip chip-live">
                <span className="dot" />
                ON
              </span>
            )}
            <CollapseButton
              collapsed={fold.collapsed}
              onToggle={fold.toggle}
              label="auto-snipe rules"
            />
          </div>
        </div>

        <p className="ssub">
          Buys launches you have <em>not</em> named, when they pass your tests. Off until you
          turn it on.
        </p>

        {/*
          Stated once, here, in the place where somebody is about to switch it
          on. It is not a disclaimer — it is the most useful thing we know.
        */}
        <p className="note-warn">
          <strong>Buying every launch loses money.</strong> We simulated about 4.9 million
          trades across 1,500 rule sets: unfiltered, every single exit strategy came out
          negative. These defaults are deliberately strict — loosen them on purpose, not by
          accident.
        </p>

        <label className="rule-toggle">
          <input
            type="checkbox"
            checked={cfg.enabled}
            disabled={locked}
            onChange={(e) => set("enabled", e.target.checked)}
          />
          <span>
            <strong>{cfg.enabled ? "Armed" : "Off"}</strong>
            <i>
              {locked
                ? "Connect a wallet to arm this."
                : cfg.enabled
                  ? `Bought ${sniper.firedThisHour} of ${cfg.maxPerHour} allowed this hour.`
                  : "Nothing buys until this is on."}
            </i>
          </span>
        </label>

        <div className="rule-grid">
          <Num label="Spend each" suffix="ETH" value={Number(cfg.eth)} disabled={locked}
               onChange={(n) => set("eth", String(n))} />
          <Num label="Max buys" suffix="per hour" value={cfg.maxPerHour} disabled={locked}
               onChange={(n) => set("maxPerHour", n)} />
          <Num label="Min holders" value={cfg.minHolders} disabled={locked}
               onChange={(n) => set("minHolders", n)} />
          <Num label="Max top 10" suffix="%" value={cfg.maxTop10Pct} disabled={locked}
               onChange={(n) => set("maxTop10Pct", n)} />
        </div>

        <Check
          label="Skip bundled launches"
          hint="one person holding several wallets to fake a crowd"
          checked={cfg.skipBundled}
          disabled={locked}
          onChange={(v) => set("skipBundled", v)}
        />
        <Check
          label="Skip if the dev already sold"
          hint="they are out; you would be buying their exit"
          checked={cfg.skipDevSold}
          disabled={locked}
          onChange={(v) => set("skipDevSold", v)}
        />
        <Check
          label="ETH-priced coins only"
          hint="over half of pons is priced in stocks like NVDA, which needs a swap first"
          checked={cfg.ethOnly}
          disabled={locked}
          onChange={(v) => set("ethOnly", v)}
        />

        {locked && (
          <button className="btn btn-primary btn-lg" onClick={onConnect}>
            Connect a wallet
          </button>
        )}
      </div>

      {/* ── the log ── */}
      <div className={`snipe${logFold.collapsed ? " is-collapsed" : ""}`}>
        <div className="card-head">
          <h3 className="shead">
            Activity {sniper.log.length > 0 && <span className="muted">· {sniper.log.length}</span>}
          </h3>
          <CollapseButton
            collapsed={logFold.collapsed}
            onToggle={logFold.toggle}
            label="sniper activity"
          />
        </div>

        {sniper.log.length === 0 ? (
          <p className="ssub">
            Every coin the sniper looks at shows up here, with what it did and why. Nothing yet.
          </p>
        ) : (
          <>
            <div className="snipelog">
              {sniper.log.map((e) => (
                <div key={`${e.at}-${e.token}`} className={`slog slog-${e.decision}`}>
                  <span className="slog-time mono">
                    {new Date(e.at).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  <span className="slog-sym">{e.symbol || "—"}</span>
                  <span className="slog-why">{e.reason}</span>
                </div>
              ))}
            </div>
            <button className="linkish" onClick={sniper.clearLog} style={{ marginTop: 8 }}>
              clear
            </button>
          </>
        )}
      </div>
    </>
  );
}
