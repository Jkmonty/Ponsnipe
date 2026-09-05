"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { directMediaUrl, mediaUrl } from "@/lib/format";

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

/** Rows that get artwork. Beyond this the initials tile stands in. */
const IMAGE_ROWS = 70;

function Avatar({ row, eager }: { row: Row; eager: boolean }) {
  /*
   * Only the first rows load an image, and that limit is the point.
   *
   * All 250 rows requesting artwork at once put 164 of them in a queue behind
   * the browser's ~6-connections-per-origin cap, and the dozen actually on
   * screen waited in it with the rest -- which is why "most of the images do
   * not work". `loading="lazy"` does not help inside a scrolling container.
   *
   * An IntersectionObserver would be the neater answer and is probably what a
   * real browser wants, but it never fires in the preview this was tested in,
   * so it could not be verified. A fixed count can be, and it bounds the
   * queue just as well.
   *
   * Three sources are tried in turn: the proxy, which resolves ipfs and caches
   * it but is 403'd by Cloudflare-fronted CDNs; then the URL directly, which
   * handles those; then the initials underneath, which are always there.
   */
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  const src = !eager ? "" : stage === 0 ? mediaUrl(row.logo) : stage === 1 ? directMediaUrl(row.logo) : "";
  return (
    <div className="savatar savatar-blank">
      {row.symbol.slice(0, 2).toUpperCase()}
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="savatar-img"
          src={src}
          alt=""
          onError={() => setStage((v) => (v === 0 ? 1 : 2))}
        />
      )}
    </div>
  );
}

/**
 * Memoised, and the comparator is the point.
 *
 * The poll replaces the whole array every two seconds, so without this all 250
 * rows re-render on every tick -- measured at 8 long tasks totalling 488ms in
 * a nine-second window, which is the main thread locking for ~60ms each
 * refresh and is what made the list feel slow to scroll. Most rows are dead
 * launches whose numbers never move, so comparing the handful of displayed
 * fields skips nearly all of that work.
 */
const FeedRow = memo(function FeedRow({
  r,
  onPick,
  eager,
}: {
  r: Row;
  onPick: (a: string) => void;
  eager: boolean;
}) {
  return (
    <button className="frow-item" onClick={() => onPick(r.token)}>
      <Avatar row={r} eager={eager} />
      <div className="fmain">
        <div className="row" style={{ gap: 6 }}>
          <strong className="ellip">{r.symbol}</strong>
          {r.isHoneypot === "yes" && <span className="pill pill-cold">honeypot</span>}
          {(r.devHoldRate ?? 0) > 0.15 && (
            <span className="pill pill-cold">dev {Math.round((r.devHoldRate ?? 0) * 100)}%</span>
          )}
          {(r.renowned ?? 0) > 0 && <span className="pill pill-hot">{r.renowned} smart</span>}
        </div>
        <div className="muted small ellip">
          {/* Abbreviated hard: the column is ~200px and the full words were
              being ellipsed away, which lost the numbers rather than the
              labels. */}
          {r.launchpad ? `${r.launchpad} · ` : ""}
          {age(r.ageMinutes)}
          {r.holders ? ` · ${r.holders} buy` : ""}
          {r.trades ? ` · ${r.trades} tx` : ""}
          {r.tradeable === false ? " · view" : ""}
        </div>
      </div>
      <span className="num small ta-r">{money(r.mcapUsd)}</span>
      <span className="num small ta-r">{money(r.volumeUsd)}</span>
      <span className="num small ta-r">
        {r.progressPct > 0 ? `${r.progressPct.toFixed(0)}%` : "—"}
      </span>
    </button>
  );
},
(a, b) =>
  a.eager === b.eager &&
  a.r.token === b.r.token &&
  a.r.mcapUsd === b.r.mcapUsd &&
  a.r.volumeUsd === b.r.volumeUsd &&
  a.r.trades === b.r.trades &&
  a.r.holders === b.r.holders &&
  a.r.progressPct === b.r.progressPct &&
  // Age is rendered coarsely, so only a change in the rendered string matters.
  Math.round(a.r.ageMinutes) === Math.round(b.r.ageMinutes));

/**
 * New pairs, newest first. Nothing else.
 *
 * Unfiltered, because a brand-new coin has no volume and no liquidity yet --
 * that is what new means -- and the $3k floors this once had hid every launch
 * until it had already matured: 16 rows survived them against 200 without.
 *
 * Each row still carries buyer and trade counts, which is what separates a
 * launch someone wants from one nobody has touched.
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
  /**
   * A finder, not a filter: it never hides a coin that would otherwise be
   * shown, it just gets you to one you already know about. Both coins reported
   * missing were present -- at positions 46 and 147 of 250 near-identical rows
   * -- which is a findability problem rather than a data one.
   */
  const [find, setFind] = useState("");

  const load = useCallback(async () => {
    if (heldRef.current) return;
    try {
      const r = await fetch("/api/feed?limit=250");
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
    const iv = setInterval(load, 2000);
    return () => clearInterval(iv);
  }, [load]);

  const all = useMemo(() => data?.rows ?? [], [data]);
  const rows = useMemo(() => {
    const q = find.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (r) =>
        r.symbol.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        r.token.toLowerCase().includes(q),
    );
  }, [all, find]);

  return (
    <aside className="feed card">
      <div className="spread" style={{ alignItems: "baseline" }}>
        <h2 style={{ margin: 0 }}>
          New coins{" "}
          <span className="muted" style={{ fontWeight: 400 }}>
            · {rows.length}
            {find.trim() && all.length !== rows.length ? ` of ${all.length}` : ""}
          </span>
        </h2>
        {held && <span className="muted small">paused</span>}
      </div>

      <input
        className="input"
        style={{ margin: "8px 0 4px", padding: "7px 10px", fontSize: 13 }}
        placeholder="Find a ticker, name or address"
        value={find}
        onChange={(e) => setFind(e.target.value)}
      />

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
        <span className="ta-r">Grad</span>
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
          rows.map((r, i) => (
            <FeedRow key={r.token} r={r} onPick={onPick} eager={i < IMAGE_ROWS} />
          ))
        )}
      </div>
    </aside>
  );
}
