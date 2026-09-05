"use client";

import { useEffect, useState } from "react";
import { mediaUrl } from "@/lib/format";

interface Suggestion {
  token: string;
  symbol: string;
  logo: string;
  quoteSymbol: string;
  kind: "curve" | "graduated";
  ageMinutes: number;
  otherBuys: number;
  liquidity: number;
  gradPct: number;
  blockedByQuote: boolean;
  priceQuote: number;
  mult: number | null;
  actionable: boolean;
  note: string;
}

interface SuggestionSet {
  preGraduation: Suggestion[];
  postGraduation: Suggestion[];
  windowMinutes: number;
  caveat: string;
}

function age(mins: number): string {
  if (mins < 1) return "just now";
  if (mins < 60) return `${Math.round(mins)}m ago`;
  return `${(mins / 60).toFixed(1)}h ago`;
}

function Row({ s, onPick }: { s: Suggestion; onPick: (addr: string) => void }) {
  // Artwork is deployer-supplied and pinned to IPFS, so a gateway timing out or
  // the CID never having been pinned is routine. Fall back to initials rather
  // than leaving a broken-image icon in the row.
  const [broken, setBroken] = useState(false);
  const logo = mediaUrl(s.logo);
  return (
    <div className="srow">
      {/* Initials sit underneath, so a gateway that is slow or never answers
          leaves a readable tile rather than an empty box. */}
      <div className="savatar savatar-blank">
        {s.symbol.slice(0, 2).toUpperCase()}
        {logo && !broken && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="savatar-img"
            src={logo}
            alt=""
            loading="lazy"
            onError={() => setBroken(true)}
          />
        )}
      </div>

      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="row" style={{ gap: 6 }}>
          <strong>{s.symbol}</strong>
          <span className="muted small">/{s.quoteSymbol}</span>
          {s.otherBuys >= 8 && <span className="pill pill-hot">{s.otherBuys} buyers</span>}
          {s.blockedByQuote && <span className="pill">needs zap</span>}
          {s.mult != null && (
            <span className={s.mult >= 1 ? "pill pill-hot" : "pill pill-cold"}>
              {s.mult >= 1 ? "+" : ""}
              {((s.mult - 1) * 100).toFixed(0)}%
            </span>
          )}
        </div>
        <div className="muted small ellip">{s.note}</div>
      </div>

      <div className="srow-meta">
        <div className="small num">
          {s.kind === "curve" ? `${s.gradPct.toFixed(0)}% to grad` : "graduated"}
        </div>
        <div className="muted small">{age(s.ageMinutes)}</div>
      </div>

      <button className="btn" onClick={() => onPick(s.token)}>
        Copy
      </button>
    </div>
  );
}

/**
 * What the sniper would have bought, had it been armed.
 *
 * The engine evaluates every launch whether or not it is enabled, so this reads
 * back its own verdicts rather than running a second strategy. It exists so the
 * decision stays with a person: the measured record of acting on these
 * automatically is negative, and that number travels with the list.
 */
export default function Suggestions({
  flash,
}: {
  flash: (k: "ok" | "err", m: string) => void;
}) {
  const [data, setData] = useState<SuggestionSet | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/suggestions");
        const j = await r.json();
        if (!alive) return;
        if (!r.ok) throw new Error(j.error ?? "could not load suggestions");
        setData(j);
        setErr(null);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : "failed");
      }
    };
    load();
    const iv = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  const pick = (addr: string) => {
    navigator.clipboard?.writeText(addr);
    flash("ok", "Address copied — paste it into Buy a token above.");
  };

  const pre = data?.preGraduation ?? [];
  const post = data?.postGraduation ?? [];

  return (
    <div className="card">
      <h2>
        Suggestions {pre.length > 0 && <span className="muted">· {pre.length} on the curve</span>}
      </h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Every launch the sniper looked at in the last {data?.windowMinutes ?? 45} minutes and
        would have bought. It watches continuously whether or not it is armed to trade.
      </p>

      {err && <p className="neg small">{err}</p>}

      <h3 className="shead">Before graduation</h3>
      {pre.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          Nothing has passed the filters recently. That is the normal state — most launches
          fail on the buyer count.
        </p>
      ) : (
        <div className="slist">
          {pre.map((s) => (
            <Row key={s.token} s={s} onPick={pick} />
          ))}
        </div>
      )}

      <h3 className="shead">After graduation</h3>
      {post.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          No graduations in the last 12 hours.
        </p>
      ) : (
        <>
          <p className="muted small" style={{ margin: "0 0 8px" }}>
            A watchlist, not a buy list — showing what each has actually done since it
            migrated.
          </p>
          <div className="slist">
            {post.map((s) => (
              <Row key={s.token} s={s} onPick={pick} />
            ))}
          </div>
        </>
      )}

      {data?.caveat && (
        <p className="muted small caveat">{data.caveat}</p>
      )}
    </div>
  );
}
