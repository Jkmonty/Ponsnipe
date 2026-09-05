"use client";

import { useEffect, useState } from "react";

/**
 * Tokens that have graduated onto a Uniswap v4 pool, read like a trading
 * terminal rather than a log: ticker and quote on the left, market cap and
 * volume on the right, move since migration coloured.
 *
 * Market cap needs no oracle. A pons pool is seeded with 10/49 of supply
 * against the whole graduation threshold, so it always opens at threshold*4.9
 * in quote units — 20.58 ETH on a native pool. Everything after that is the
 * opening cap times the price move.
 *
 * The move is the number worth watching: our own scan found the median
 * graduated token down 32% an hour after migration and 59% after twelve, so a
 * green one here is genuinely unusual rather than the default.
 */

interface GraduationRow {
  id: number;
  ts: string;
  token_address: string;
  token_symbol: string | null;
  token_name: string | null;
  logo: string | null;
  quote_symbol: string | null;
  open_mcap: number | null;
  last_mult: number | null;
  mcap: number | null;
  volume: number | null;
  txs: number | null;
}

function age(ts: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** 1234567 -> 1.2M. Quote units, not dollars — we have no price feed. */
function compact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "–";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(2);
}

function TokenIcon({ logo, symbol }: { logo: string | null; symbol: string | null }) {
  const [bad, setBad] = useState(false);
  if (!logo || bad) {
    return <span className="ticon ticon-fallback">{(symbol ?? "?").slice(0, 1).toUpperCase()}</span>;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="ticon" src={logo} alt="" loading="lazy" onError={() => setBad(true)} />;
}

export default function MigratedFeed() {
  const [rows, setRows] = useState<GraduationRow[]>([]);
  const [, tick] = useState(0);

  useEffect(() => {
    const load = async () => {
      try {
        const j = await fetch("/api/sniper?limit=1").then((r) => r.json());
        if (Array.isArray(j.graduations)) setRows(j.graduations);
      } catch {
        /* transient */
      }
    };
    load();
    const iv = setInterval(load, 6000);
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      clearInterval(iv);
      clearInterval(t);
    };
  }, []);

  const green = rows.filter((r) => (r.last_mult ?? 1) > 1).length;

  return (
    <div className="card feedcard">
      <div className="spread">
        <h2>Migrated</h2>
        <span className="small muted">
          {rows.length} recent · <span className={green ? "pos" : "muted"}>{green} up</span>
        </span>
      </div>
      <div className="small muted" style={{ marginBottom: 10 }}>
        Graduated onto a v4 pool. Median token is −32% an hour later, so green is rare.
      </div>

      {rows.length === 0 && <div className="small muted">Nothing yet — graduations are rare.</div>}

      <div className="feed">
        {rows.map((r) => {
          const mult = r.last_mult ?? 1;
          const movePct = (mult - 1) * 100;
          const cls = movePct > 1 ? "pos" : movePct < -1 ? "neg" : "muted";
          return (
            <div key={r.id} className="grow">
              <div className="growleft">
                <TokenIcon logo={r.logo} symbol={r.token_symbol} />
                <div className="growname">
                  <div className="row" style={{ gap: 6, alignItems: "center", minWidth: 0 }}>
                    <span className="fsym">{r.token_symbol ?? "?"}</span>
                    <span className={`qchip q-${(r.quote_symbol ?? "?").toLowerCase()}`}>
                      {r.quote_symbol ?? "?"}
                    </span>
                  </div>
                  <div className="small muted growsub">{r.token_name ?? ""}</div>
                </div>
              </div>
              <div className="growright">
                <div className="growmc">
                  <span className="muted">MC</span> {compact(r.mcap)}
                  <span className="muted"> {r.quote_symbol}</span>
                </div>
                <div className="small">
                  <span className="muted">V</span> {compact(r.volume)}
                  <span className="muted"> · {r.txs ?? 0} tx · {age(r.ts)}</span>
                </div>
              </div>
              <div className={`growmove ${cls}`}>
                {movePct >= 0 ? "+" : ""}
                {Math.abs(movePct) >= 100 ? movePct.toFixed(0) : movePct.toFixed(1)}%
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
