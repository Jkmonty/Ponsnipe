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
  mcapUsd: number | null;
  volumeUsd: number | null;
  liquidityUsd: number | null;
  /** Chain-source rows carry a quote asset; GMGN rows are already in dollars. */
  quoteSymbol?: string;
  launchpad?: string;
  holders?: number;
  devHoldRate?: number;
  isHoneypot?: string;
  renowned?: number;
  /** False when the token is not a pons launch, so this app cannot buy it. */
  tradeable?: boolean;
}

interface Payload {
  source: "gmgn" | "chain";
  rows: Row[];
  ethUsd?: number | null;
  total: number;
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
  // Artwork is deployer-supplied and often pinned to a slow gateway, so the
  // initials sit underneath rather than leaving an empty tile.
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
 * New coins, newest first, unfiltered.
 *
 * There were thresholds here and they were the wrong idea: a brand-new coin has
 * no volume and no liquidity yet, because that is what new means, so a $3k floor
 * on either hid every launch until it had already matured. Measured at the time:
 * 16 rows survived the floors against 200 without them, 180 of which had
 * launched in the previous five minutes. A new-pairs feed should show new pairs.
 */
export default function Feed({ onPick }: { onPick: (address: string) => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /**
   * Rows re-sort on every poll, so a list refreshing under the cursor moved the
   * row you were aiming at out from under the click. Hovering freezes it.
   */
  const [held, setHeld] = useState(false);
  const heldRef = useRef(false);
  heldRef.current = held;

  const load = useCallback(async () => {
    if (heldRef.current) return;
    try {
      const r = await fetch("/api/feed?limit=120");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "feed unavailable");
      setData(j);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [load]);

  const rows = data?.rows ?? [];

  return (
    <aside className="feed card">
      <div className="spread" style={{ alignItems: "baseline" }}>
        <h2 style={{ margin: 0 }}>
          New coins{" "}
          <span className="muted" style={{ fontWeight: 400 }}>
            · {rows.length}
          </span>
        </h2>
        {held && <span className="muted small">paused</span>}
      </div>

      <p className="muted small" style={{ margin: "4px 0 10px" }}>
        {data?.source === "gmgn" ? (
          <>
            {/* Naming both sources, because they are not interchangeable: GMGN's
                new-token stream for this chain does not carry pons launches at
                all — pons appears there only once graduated — so the pons rows,
                which are the ones this app can buy, come from our own index. */}
            pons launches indexed here, every other launchpad via GMGN
            {data.status.ageSeconds != null ? ` (updated ${data.status.ageSeconds}s ago)` : ""}.
            Rows marked <em>view only</em> are not pons launches, so this app cannot buy them.
          </>
        ) : (
          <>
            Live from the chain, newest first.{" "}
            {data?.ethUsd ? `ETH $${Math.round(data.ethUsd).toLocaleString()}.` : ""}
          </>
        )}
      </p>

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
            {data ? "Nothing yet." : "Loading…"}
          </p>
        ) : (
          rows.map((r) => (
            <button key={r.token} className="frow-item" onClick={() => onPick(r.token)}>
              <Avatar row={r} />
              <div className="fmain">
                <div className="row" style={{ gap: 6 }}>
                  <strong className="ellip">{r.symbol}</strong>
                  {r.quoteSymbol ? <span className="muted small">/{r.quoteSymbol}</span> : null}
                  {r.isHoneypot === "yes" && <span className="pill pill-cold">honeypot</span>}
                  {(r.devHoldRate ?? 0) > 0.15 && (
                    <span className="pill pill-cold">dev {Math.round((r.devHoldRate ?? 0) * 100)}%</span>
                  )}
                  {(r.renowned ?? 0) > 0 && <span className="pill pill-hot">{r.renowned} smart</span>}
                </div>
                {/* Launchpad leads the sub-line rather than sitting as a chip:
                    the column is too narrow for another one, and it is the
                    first thing worth knowing about a row. */}
                <div className="muted small ellip">
                  {r.launchpad ? `${r.launchpad} · ` : ""}
                  {age(r.ageMinutes)}
                  {r.trades ? ` · ${r.trades} tx` : ""}
                  {r.holders ? ` · ${r.holders} holders` : ""}
                  {r.tradeable === false ? " · view only" : ""}
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
