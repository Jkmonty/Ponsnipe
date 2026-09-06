"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { directMediaUrl, mediaUrl } from "@/lib/format";

interface Row {
  token: string;
  symbol: string;
  name: string;
  logo: string;
  quoteSymbol: string;
  ageMinutes: number;
  trades: number;
  buys: number;
  sells: number;
  holders: number;
  progressPct: number;
  devLaunches: number;
  devHoldRate: number;
  devSold: boolean;
  top10Rate: number;
  mcapUsd: number | null;
  volumeUsd: number | null;
  liquidityUsd: number | null;
  socials: string;
  description: string;
  snipers: number;
  sameBlock: number;
}

interface Payload {
  rows: Row[];
  total: number;
  ethUsd: number | null;
  unpriced: string[];
  status: { running: boolean; lastError: string | null };
}

/** Compact money: $12.3k, $1.2M — the feed has no room for full numbers. */
function money(n: number | null): string {
  if (n == null) return "—";
  // A brand-new coin has no volume by definition, and a column of "$0.00"
  // reads as a broken number rather than an empty one.
  if (n === 0) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  if (a >= 1) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

/** 0x31a4…1d07 — enough to recognise a token you already know. */
function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function age(m: number): string {
  if (m < 1) return "now";
  if (m < 60) return `${Math.round(m)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

/**
 * What the token linked, as a label and a host.
 *
 * pons stores a single socials() string on the token, not the set of accounts
 * a launchpad form would collect, and across a 60-token sample every one that
 * had anything had exactly one link: 39 x.com, 3 twitter.com, nothing else.
 * So this labels whatever is there rather than rendering a row of icons that
 * would be empty in every position but one.
 */
function socialOf(raw: string): { label: string; href: string } | null {
  const t = (raw ?? "").trim();
  if (!/^https?:\/\//i.test(t)) return null;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  const h = u.hostname.replace(/^www\./, "").toLowerCase();
  const known: Record<string, string> = {
    "x.com": "X",
    "twitter.com": "X",
    "t.me": "Telegram",
    "telegram.me": "Telegram",
    "discord.gg": "Discord",
    "discord.com": "Discord",
    "instagram.com": "Instagram",
    "reddit.com": "Reddit",
    "youtube.com": "YouTube",
    "tiktok.com": "TikTok",
    "github.com": "GitHub",
  };
  // An X profile is worth more than the bare host: a link to someone's
  // account reads differently from a link to a post about the coin.
  const handle =
    (h === "x.com" || h === "twitter.com") && /^\/[A-Za-z0-9_]{1,15}\/?$/.test(u.pathname)
      ? `@${u.pathname.replace(/\//g, "")}`
      : null;
  return { label: handle ?? known[h] ?? h, href: t };
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
  const soc = socialOf(r.socials);
  const pick = () => onPick(r.token);
  return (
    /*
     * A div rather than a button. The row holds a real anchor to whatever the
     * token linked, an anchor cannot be nested inside a button, and floating
     * one above the button instead put it on top of the market cap. Keyboard
     * activation is wired up by hand to keep what the button gave for free.
     */
    <div
      className="frow-item"
      role="button"
      tabIndex={0}
      onClick={pick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          pick();
        }
      }}
      title={r.description || undefined}
    >
      <Avatar row={r} eager={eager} />
      <div className="fmain">
        <div className="fline1">
          <strong className="ellip">{r.symbol}</strong>
          <span className="muted small ellip fname">{r.name}</span>
          {soc && (
            <a
              className="fsoc ellip"
              href={soc.href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              title={soc.href}
              onClick={(e) => e.stopPropagation()}
            >
              {soc.label}
            </a>
          )}
        </div>

        <div className="fline2 muted small">
          <span className="faddr" title={r.token}>{shortAddr(r.token)}</span>
          <span className="fstat" title="how long ago it launched">{age(r.ageMinutes)}</span>
          <span className="fstat" title="wallets still holding">
            <i className="fi">H</i>
            {r.holders}
          </span>
          {r.trades > 0 && (
            <span className="fstat" title={`${r.buys} buys, ${r.sells} sells`}>
              <i className="fi">B/S</i>
              <span className="pos">{r.buys}</span>
              <span className="muted">/</span>
              <span className="neg">{r.sells}</span>
            </span>
          )}
          {r.snipers > 0 && (
            <span
              className={`fstat ${r.snipers >= 5 ? "warn" : ""}`}
              title={`${r.snipers} wallets other than the deployer bought within 3 blocks of launch${
                r.sameBlock ? `, ${r.sameBlock} in the launch block itself` : ""
              }`}
            >
              <i className="fi">SNIPE</i>
              {r.snipers}
            </span>
          )}
          <span className="fquote" title="what this curve trades against">{r.quoteSymbol}</span>

          <span className="fbond-wrap">
            {r.devHoldRate > 0.05 && (
              <span className="pill pill-cold" title="how much of their own coin the maker holds">
                maker {Math.round(r.devHoldRate * 100)}%
              </span>
            )}
            {r.devSold && <span className="pill pill-cold">maker sold</span>}
            {r.top10Rate > 0.2 && (
              <span className="pill" title="how much the ten biggest wallets hold between them">
                top 10 {Math.round(r.top10Rate * 100)}%
              </span>
            )}
            {/* Progress to graduation, as a bar: it is the one field on the
                row that is a fraction of a known whole. */}
            <span className="fbond" title={`${r.progressPct.toFixed(1)}% of the way to graduating`}>
              <span className="fbond-fill" style={{ width: `${Math.min(100, r.progressPct)}%` }} />
              <span className="fbond-txt">{r.progressPct > 0 ? `${r.progressPct.toFixed(0)}%` : "0%"}</span>
            </span>
          </span>
        </div>
      </div>

      <span className="fnum num" title="market cap">
        {money(r.mcapUsd)}
      </span>
      <span className="fnum num" title="volume">
        {money(r.volumeUsd)}
      </span>
      <span className="fnum num" title="liquidity in the curve">
        {money(r.liquidityUsd)}
      </span>
      <span className="fnum num" title="trades">
        {r.trades || "—"}
        <small>{r.holders ? `${r.holders} hold` : ""}</small>
      </span>
    </div>
  );
},
(a, b) =>
  a.eager === b.eager &&
  a.r.token === b.r.token &&
  a.r.mcapUsd === b.r.mcapUsd &&
  a.r.volumeUsd === b.r.volumeUsd &&
  a.r.liquidityUsd === b.r.liquidityUsd &&
  a.r.trades === b.r.trades &&
  a.r.buys === b.r.buys &&
  a.r.sells === b.r.sells &&
  a.r.holders === b.r.holders &&
  a.r.devHoldRate === b.r.devHoldRate &&
  a.r.devSold === b.r.devSold &&
  a.r.top10Rate === b.r.top10Rate &&
  a.r.progressPct === b.r.progressPct &&
  a.r.snipers === b.r.snipers &&
  a.r.socials === b.r.socials &&
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
      {/*
        One line of chrome, not three. The title, the count, the live/paused
        state, the finder and the ETH price were four stacked blocks eating
        ~90px above the first row — on the column that IS the page.
      */}
      <div className="feedhead">
        <h2 style={{ margin: 0 }}>
          New coins{" "}
          <span className="muted" style={{ fontWeight: 400 }}>
            · {rows.length}
            {find.trim() && all.length !== rows.length ? ` of ${all.length}` : ""}
          </span>
        </h2>
        <span className={`livedot${held ? " livedot-held" : ""}`} title={held ? "Paused while you hover" : "Live"}>
          <i />
          {held ? "paused" : "live"}
        </span>
        <input
          className="input feedfind"
          placeholder="Find a ticker, name or address"
          value={find}
          onChange={(e) => setFind(e.target.value)}
        />
        {data?.ethUsd ? (
          <span className="muted small num" style={{ flex: "none" }}>
            ETH ${Math.round(data.ethUsd).toLocaleString()}
          </span>
        ) : null}
      </div>

      {err && <p className="neg small">{err}</p>}
      {!err && data && !data.status.running && (
        <p className="neg small">Feed is not running — restart the app.</p>
      )}

      <div className="fhead">
        <span>Coin</span>
        <span className="ta-r">MC</span>
        <span className="ta-r">Vol</span>
        <span className="ta-r">Liq</span>
        <span className="ta-r">Tx</span>
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
