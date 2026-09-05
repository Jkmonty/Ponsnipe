"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mediaUrl } from "@/lib/format";

interface Row {
  token: string;
  symbol: string;
  name: string;
  logo: string;
  ageMinutes: number;
  trades: number;
  progressPct: number;
  /** Chain-source rows carry a quote asset; GMGN rows are already in dollars. */
  quoteSymbol?: string;
  mcapUsd: number | null;
  volumeUsd: number | null;
  liquidityUsd: number | null;
  /** GMGN only. */
  launchpad?: string;
  holders?: number;
  devHoldRate?: number;
  top10HoldRate?: number;
  freshWalletRate?: number;
  sniperHoldRate?: number;
  insiderHoldRate?: number;
  isHoneypot?: string;
  renowned?: number;
  tradeable?: boolean;
}

interface Filters {
  minMcapUsd: number | null;
  minVolumeUsd: number | null;
  minLiquidityUsd: number | null;
  volumeWindowMin: number;
  includeUnpriced: boolean;
  quote: "all" | "eth" | "stable";
}

interface Payload {
  source: "gmgn" | "chain";
  rows: Row[];
  ethUsd?: number | null;
  total: number;
  launchpads?: string[];
  /** Quote assets with no dollar rate. Chain source only; usually empty. */
  unpriced?: string[];
  status: { running: boolean; lastError: string | null; ageSeconds?: number | null };
}

/** Compact money: $12.3k, $1.2M — the feed has no room for full numbers. */
function money(n: number | null): string {
  if (n == null) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  if (a >= 1) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

function age(m: number): string {
  if (m < 1) return "now";
  if (m < 60) return `${Math.round(m)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function Avatar({ row }: { row: Row }) {
  const [broken, setBroken] = useState(false);
  const logo = mediaUrl(row.logo);
  return (
    <div className="savatar savatar-blank">
      {row.symbol.slice(0, 2).toUpperCase()}
      {logo && !broken && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="savatar-img" src={logo} alt="" loading="lazy" onError={() => setBroken(true)} />
      )}
    </div>
  );
}

/**
 * New coins, newest first.
 *
 * Filters default to on. An unfiltered feed of this chain is ~24,000 launches a
 * day, nearly all of which never attract a second buyer, so the useful default
 * is a floor rather than everything.
 */
export default function Feed({ onPick }: { onPick: (address: string) => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  /**
   * Rows re-sort on every poll, so a list that refreshed under the cursor moved
   * the row you were aiming at out from under the click. Hovering freezes it,
   * the way every other live feed does.
   */
  const [held, setHeld] = useState(false);
  const heldRef = useRef(false);
  heldRef.current = held;
  const [f, setF] = useState<Filters>({
    minMcapUsd: 3000,
    minVolumeUsd: 3000,
    minLiquidityUsd: 3000,
    volumeWindowMin: 60,
    includeUnpriced: false,
    quote: "all",
  });
  const [tradeableOnly, setTradeableOnly] = useState(false);
  const [launchpad, setLaunchpad] = useState("");

  const load = useCallback(async () => {
    const q = new URLSearchParams({
      minMcap: f.minMcapUsd == null ? "off" : String(f.minMcapUsd),
      minVolume: f.minVolumeUsd == null ? "off" : String(f.minVolumeUsd),
      minLiquidity: f.minLiquidityUsd == null ? "off" : String(f.minLiquidityUsd),
      window: String(f.volumeWindowMin),
      unpriced: f.includeUnpriced ? "1" : "0",
      quote: f.quote,
      tradeable: tradeableOnly ? "1" : "0",
    });
    if (launchpad) q.set("launchpad", launchpad);
    if (heldRef.current) return;
    try {
      const r = await fetch(`/api/feed?${q}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "feed unavailable");
      setData(j);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    }
  }, [f, tradeableOnly, launchpad]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 8000);
    return () => clearInterval(iv);
  }, [load]);

  const rows = data?.rows ?? [];
  const num = (v: number | null) => (v == null ? "" : String(v));
  const parse = (v: string): number | null => {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  return (
    <aside className="feed card">
      <div className="spread" style={{ alignItems: "baseline" }}>
        <h2 style={{ margin: 0 }}>
          New coins{" "}
          <span className="muted" style={{ fontWeight: 400 }}>
            · {rows.length}
            {data && data.total > rows.length ? ` of ${data.total}` : ""}
          </span>
        </h2>
        <div className="row" style={{ gap: 10 }}>
          {held && <span className="muted small">paused</span>}
          <button className="linkish" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide filters" : "Filters"}
          </button>
        </div>
      </div>

      <p className="muted small" style={{ margin: "4px 0 10px" }}>
        {data?.source === "gmgn" ? (
          <>
            Every launchpad on the chain, via GMGN
            {data.status.ageSeconds != null ? ` · updated ${data.status.ageSeconds}s ago` : ""}.
            Rows marked <em>view only</em> are not pons launches, so this app cannot buy them.
          </>
        ) : (
          <>
            Live from the chain, newest first.{" "}
            {data?.ethUsd
              ? `Priced in USD via ETH $${Math.round(data.ethUsd).toLocaleString()} and live share prices.`
              : "No price feed — dollar figures unavailable."}
          </>
        )}
      </p>

      {open && (
        <div className="filters">
          <label className="f">
            <span>Min market cap $</span>
            <input
              className="input"
              inputMode="numeric"
              value={num(f.minMcapUsd)}
              placeholder="off"
              onChange={(e) => setF({ ...f, minMcapUsd: parse(e.target.value) })}
            />
          </label>
          <label className="f">
            <span>Min volume $</span>
            <input
              className="input"
              inputMode="numeric"
              value={num(f.minVolumeUsd)}
              placeholder="off"
              onChange={(e) => setF({ ...f, minVolumeUsd: parse(e.target.value) })}
            />
          </label>
          <label className="f">
            <span>Min liquidity $</span>
            <input
              className="input"
              inputMode="numeric"
              value={num(f.minLiquidityUsd)}
              placeholder="off"
              onChange={(e) => setF({ ...f, minLiquidityUsd: parse(e.target.value) })}
            />
          </label>
          <label className="f">
            <span>Volume window</span>
            <select
              className="input"
              value={f.volumeWindowMin}
              onChange={(e) => setF({ ...f, volumeWindowMin: Number(e.target.value) })}
            >
              <option value={5}>5 min</option>
              <option value={15}>15 min</option>
              <option value={60}>1 hour</option>
              <option value={180}>3 hours</option>
            </select>
          </label>
          <label className="f">
            <span>Paired with</span>
            <select
              className="input"
              value={f.quote}
              onChange={(e) => setF({ ...f, quote: e.target.value as Filters["quote"] })}
            >
              <option value="all">Anything</option>
              <option value="eth">ETH only</option>
              <option value="stable">Not ETH</option>
            </select>
          </label>
          {data?.source === "gmgn" && (
            <>
              <label className="f">
                <span>Launchpad</span>
                <select className="input" value={launchpad} onChange={(e) => setLaunchpad(e.target.value)}>
                  <option value="">All</option>
                  {(data.launchpads ?? []).map((lp) => (
                    <option key={lp} value={lp}>
                      {lp}
                    </option>
                  ))}
                </select>
              </label>
              <label className="f frow">
                <input
                  type="checkbox"
                  checked={tradeableOnly}
                  onChange={(e) => setTradeableOnly(e.target.checked)}
                />
                <span className="muted small">
                  Only coins this app can buy (pons curves). Everything else is view only.
                </span>
              </label>
            </>
          )}
          <label className="f frow" hidden={data?.source === "gmgn"}>
            <input
              type="checkbox"
              checked={f.includeUnpriced}
              onChange={(e) => setF({ ...f, includeUnpriced: e.target.checked })}
            />
            <span className="muted small">
              Show coins whose quote asset has no dollar price
              {data?.unpriced?.length ? ` (${data.unpriced.join(", ")})` : ""}. The dollar
              filters cannot be applied to those, so they are hidden by default.
            </span>
          </label>
        </div>
      )}

      {err && <p className="neg small">{err}</p>}
      {!err && data && !data.status.running && (
        <p className="neg small">Feed is not running — restart the app.</p>
      )}

      <div className="fhead">
        <span>Coin</span>
        <span className="ta-r">MC</span>
        <span className="ta-r">Vol</span>
        <span className="ta-r">Liq</span>
      </div>

      <div
        className="flist"
        onMouseEnter={() => setHeld(true)}
        onMouseLeave={() => setHeld(false)}
      >
        {rows.length === 0 ? (
          <p className="muted small" style={{ margin: "10px 0" }}>
            {data ? "Nothing clears these filters yet. Lower them or wait." : "Loading…"}
          </p>
        ) : (
          rows.map((r) => (
            <button key={r.token} className="frow-item" onClick={() => onPick(r.token)}>
              <Avatar row={r} />
              <div className="fmain">
                <div className="row" style={{ gap: 6 }}>
                  <strong className="ellip">{r.symbol}</strong>
                  <span className="muted small">/{r.quoteSymbol}</span>
                </div>
                <div className="muted small ellip">
                  {age(r.ageMinutes)} · {r.trades} tx · {r.progressPct.toFixed(0)}%
                </div>
              </div>
              <span className="num small ta-r">{money(r.mcapUsd)}</span>
              <span className="num small ta-r">{money(r.volumeUsd)}</span>
              <span className="num small ta-r">{money(r.liquidityUsd)}</span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
