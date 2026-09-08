"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import FeedFilters from "./FeedFilters";
import {
  DEFAULT_FILTERS,
  activeCount,
  passes,
  readFilters,
  writeFilters,
  type Filters,
} from "./filterRules";
import { mediaUrl } from "@/lib/format";

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
  spark: number[];
  bundled: number;
}

interface Payload {
  rows: Row[];
  total: number;
  ethUsd: number | null;
  unpriced: string[];
  status: { running: boolean; lastError: string | null };
}

/** Compact money: $12.3k, $1.2M — the feed has no room for full numbers. */
/**
 * True when money() will render a dash rather than a figure.
 *
 * Derived from money() rather than guessed at: the cell is blank for zero as
 * well as for null, and checking only for null left every zero-volume row
 * showing a full-weight em dash — which is almost all of them.
 */
function isBlank(n: number | null): boolean {
  return n == null || n === 0;
}

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

/**
 * Twenty minutes of price, as an area.
 *
 * Green when it ends above where it started, red below — the colour IS the
 * reading, so the shape does not have to be studied to be useful.
 *
 * Scaled to its own range rather than to zero. A memecoin that moves 4% in
 * twenty minutes and one that does 10x both need to be legible on a 54px
 * line, and a zero-based axis would flatten the first into a straight line.
 * The floor is padded so a perfectly flat price still draws through the
 * middle instead of along the bottom edge.
 */
const SparkLine = memo(function SparkLine({ points }: { points: number[] }) {
  if (points.length < 2) return <span className="spark spark-empty" />;

  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const first = points[0];
  const last = points[points.length - 1];
  /*
   * Flat is its own state, not a gain.
   *
   * `last >= first` painted every untraded coin green, and most of them are
   * untraded — 92 of 99 charts came back "up" on the first live sample, of
   * which nearly all had not moved at all. A price that has not changed is
   * grey.
   */
  const dir = last > first ? 1 : last < first ? -1 : 0;

  const w = 54;
  const h = 16;
  const pad = 2;
  // A flat series has no range to divide by; give it one so it sits centred.
  const span = hi - lo || Math.abs(hi) || 1;
  const step = w / (points.length - 1);
  const y = (v: number) => h - pad - ((v - lo) / span) * (h - pad * 2);
  const line = points.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const stroke = dir > 0 ? "var(--green)" : dir < 0 ? "var(--red)" : "var(--muted-2)";
  const fill =
    dir > 0 ? "rgba(47,212,143,.15)" : dir < 0 ? "rgba(255,107,107,.13)" : "rgba(153,161,181,.10)";

  const pct = first > 0 ? ((last - first) / first) * 100 : 0;
  return (
    <svg
      className="spark"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={
        dir === 0
          ? `price unchanged over ${points.length} minutes`
          : `${dir > 0 ? "up" : "down"} ${Math.abs(pct).toFixed(1)}% over ${points.length} minutes`
      }
    >
      <polyline
        points={`0,${h} ${line} ${w},${h}`}
        fill={fill}
        stroke="none"
      />
      <polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth="1.3"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* The live end of the line, so the eye lands on now. */}
      <circle cx={w} cy={y(last)} r="1.7" fill={stroke} />
    </svg>
  );
});

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
   * Two sources, not three. The proxy resolves ipfs and caches it; failing
   * that, the initials underneath, which are always there.
   *
   * There used to be a middle step that loaded the contract's own URL directly.
   * It rescued the images that Cloudflare-fronted CDNs 403 at the proxy, and it
   * cost an img-src of `https:` — permission for this page to issue a GET to
   * any host on the internet. On a page holding an unlocked key that is an
   * exfiltration channel: an injected script cannot fetch() a secret out, but
   * it can put one in an image URL. Every logo is same-origin now, so img-src
   * is 'self' and that channel is closed. The price is that some artwork shows
   * as initials.
   */
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  const src = !eager || stage !== 0 ? "" : mediaUrl(row.logo);
  return (
    <div className="savatar savatar-blank">
      {row.symbol.slice(0, 2).toUpperCase()}
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="savatar-img"
          src={src}
          alt=""
          onError={() => setStage(2)}
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
/**
 * Rows flash when the number behind them moves.
 *
 * The feed repaints every two seconds and, until now, a market cap doubling
 * looked exactly like a market cap sitting still — the figure was simply
 * different the next time you happened to look at it. This marks the change
 * for long enough to catch the eye and no longer.
 */
function useFlash(value: number | null): string {
  const prev = useRef(value);
  const [cls, setCls] = useState("");
  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (before == null || value == null || before === value) return;
    setCls(value > before ? " flash-up" : " flash-down");
    const t = setTimeout(() => setCls(""), 780);
    return () => clearTimeout(t);
  }, [value]);
  return cls;
}

const FeedRow = memo(function FeedRow({
  r,
  onPick,
  eager,
  fresh,
}: {
  r: Row;
  onPick: (a: string) => void;
  eager: boolean;
  /** First time this row has been rendered, so it can animate in. */
  fresh: boolean;
}) {
  const mcFlash = useFlash(r.mcapUsd);
  const volFlash = useFlash(r.volumeUsd);
  const soc = socialOf(r.socials);
  /* Nothing has happened on this curve yet: no trades, no volume, no
     liquidity. Measured on the live feed, that is about half of every launch. */
  const untraded = !r.trades && !r.volumeUsd && !r.liquidityUsd;
  const pick = () => onPick(r.token);
  return (
    /*
     * A div rather than a button. The row holds a real anchor to whatever the
     * token linked, an anchor cannot be nested inside a button, and floating
     * one above the button instead put it on top of the market cap. Keyboard
     * activation is wired up by hand to keep what the button gave for free.
     */
    <div
      className={`frow-item${fresh ? " frow-new" : ""}`}
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
          {/*
            Age, plainly. It used to carry a lime dot and lime text when under
            a minute old, but the feed is sorted newest-first so nearly every
            visible row had one — a status everything shares is not a status.
          */}
          <span className="fage" title="how long ago it launched">
            {age(r.ageMinutes)}
          </span>
        </div>

        <div className="fline2 muted small">
          {/* What it trades against, first. Over half of pons is priced in a
              tokenised stock rather than ETH, which changes what a position
              in it actually is — so it leads the metadata rather than sitting
              seventh along the line. */}
          <span className="fquote" title="what this curve trades against">{r.quoteSymbol}</span>
          {/* A crowd already holding is the strongest signal we ever
              measured, so the count brightens once there is one. */}
          <span className={`fstat${r.holders >= 10 ? " good" : ""}`} title="wallets still holding">
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
          {/* Only rendered on narrow screens, where the Vol and Liq columns
              are hidden — without this a phone loses them entirely. */}
          <span className="fstat onlynarrow" title="volume">
            <i className="fi">VOL</i>
            {money(r.volumeUsd)}
          </span>

          <span className="fbond-wrap">
            {r.devHoldRate > 0.05 && (
              <span className="pill pill-cold" title="how much of their own coin the maker holds">
                maker {Math.round(r.devHoldRate * 100)}%
              </span>
            )}
            {r.devSold && <span className="pill pill-cold">maker sold</span>}
            {/* One operator wearing several wallets. Worth more than the
                holder count next to it, because it says that count is a
                costume. */}
            {r.bundled >= 2 && (
              <span
                className={`pill ${r.bundled >= 4 ? "pill-hot" : ""}`}
                title={`${r.bundled} of this coin's buyers are wallets funded from the same source — one operator, not ${r.bundled} people. Wallets newer than the last cluster scan are not counted, so the real number can only be higher.`}
              >
                {r.bundled} bundled
              </span>
            )}
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

          {/* Last and quietest. The contract address is the least-read thing
              on the row and it was leading the line in monospace, which gave
              the dullest field the most distinctive shape. */}
          <span className="faddr" title={r.token}>{shortAddr(r.token)}</span>
        </div>
      </div>

      <SparkLine points={r.spark} />

      {/* `is-blank` dims a cell with no figure in it. On a launch seconds old
          three of these five columns are an em dash, and at full weight that
          is a wall of punctuation competing with the numbers that are real. */}
      <span className={`fnum fnum-mc num${mcFlash}${isBlank(r.mcapUsd) ? " is-blank" : ""}`} title="market cap">
        {money(r.mcapUsd)}
      </span>
      {untraded ? (
        /*
          One statement instead of three dashes.

          Half of all launches never trade, so half the feed was showing an em
          dash under volume, another under liquidity and a third under trades —
          three separate pieces of punctuation for a single fact. Said once,
          across the space the three of them occupied.
        */
        <span className="fnum fno-trades" title="nobody has traded this yet">
          no trades yet
        </span>
      ) : (
        <>
          <span className={`fnum fnum-vol num${volFlash}${isBlank(r.volumeUsd) ? " is-blank" : ""}`} title="volume">
            {money(r.volumeUsd)}
          </span>
          <span
            className={`fnum fnum-liq num${isBlank(r.liquidityUsd) ? " is-blank" : ""}`}
            title="liquidity in the curve"
          >
            {money(r.liquidityUsd)}
          </span>
          <span className="fnum fnum-tx num" title="trades">
            {r.trades || "—"}
            <small>{r.holders ? `${r.holders} hold` : ""}</small>
          </span>
        </>
      )}
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
  a.r.bundled === b.r.bundled &&
  // Cheap enough: 20 numbers, and it changes at most once a minute.
  a.r.spark.join() === b.r.spark.join() &&
  a.fresh === b.fresh &&
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
/** How long the list stays frozen after the pointer stops moving over it. */
const HOLD_IDLE_MS = 3000;

export default function Feed({ onPick }: { onPick: (address: string) => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /**
   * Rows re-sort on every poll, so a list refreshing under the cursor moved the
   * row you were aiming at out from under the click. Moving over it freezes it.
   *
   * On hover alone this froze the whole feed — new coins, prices, volume, the
   * lot — for as long as the pointer sat anywhere over 250 rows, which is
   * where a pointer sits while you read. Reading the feed stopped the feed,
   * and it looked like the app had died.
   *
   * So the hold follows movement, not presence: aiming at a row keeps it
   * still, and three seconds after the pointer stops the feed resumes with the
   * cursor exactly where it was. The case this protects against is the click
   * you are in the middle of making, which is never three seconds long.
   */
  const [held, setHeld] = useState(false);
  const heldRef = useRef(false);
  heldRef.current = held;
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /**
   * A finder, not a filter: it never hides a coin that would otherwise be
   * shown, it just gets you to one you already know about. Both coins reported
   * missing were present -- at positions 46 and 147 of 250 near-identical rows
   * -- which is a findability problem rather than a data one.
   */
  const [find, setFind] = useState("");
  const findRef = useRef<HTMLInputElement>(null);
  /*
   * Which modifier to name in the hint.
   *
   * Read once on mount rather than during render: the server has no navigator,
   * so branching on it while rendering would make the first client paint
   * disagree with the server's HTML.
   */
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
  }, []);

  /** Cmd/Ctrl-K jumps to the finder from anywhere on the page. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        findRef.current?.focus();
        findRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  /** Freeze the list, and start the clock that thaws it. */
  const hold = useCallback(() => {
    clearTimeout(holdTimer.current);
    setHeld(true);
    holdTimer.current = setTimeout(() => setHeld(false), HOLD_IDLE_MS);
  }, []);

  /** Thaw now, and catch up immediately rather than at the next tick. */
  const release = useCallback(() => {
    clearTimeout(holdTimer.current);
    setHeld(false);
    void load();
  }, [load]);

  /*
   * A pointer that leaves through the window edge, or a tab that goes to the
   * background, never sends mouseleave. Without this the feed could come back
   * to a frozen list an hour later.
   */
  useEffect(() => {
    const off = () => release();
    window.addEventListener("blur", off);
    document.addEventListener("visibilitychange", off);
    return () => {
      window.removeEventListener("blur", off);
      document.removeEventListener("visibilitychange", off);
      clearTimeout(holdTimer.current);
    };
  }, [release]);

  /** True while the push connection is up, so the UI can say which it is on. */
  const [pushed, setPushed] = useState(false);

  useEffect(() => {
    load();

    /*
     * Pushed, with a poll underneath.
     *
     * A launch is indexed in about 0.09s and the browser used to wait up to
     * two more seconds to ask about it — the largest remaining delay in the
     * path, and all of it after the hard part. The stream says "something
     * landed" and this fetches; it carries no rows itself, so there is still
     * one copy of the query, the USD conversion and the ordering.
     *
     * The interval stays, at ten seconds rather than two. If the stream is
     * refused, dies, or was never established, the feed gets slower and stays
     * correct — which is the right way round for something that decides what
     * you buy. EventSource reconnects on its own, so there is nothing to
     * retry here.
     */
    let es: EventSource | null = null;
    try {
      es = new EventSource("/api/feed/stream");
      es.onopen = () => setPushed(true);
      es.onmessage = () => load();
      es.onerror = () => setPushed(false);
    } catch {
      // No EventSource, or blocked: the poll below is the whole mechanism.
    }

    const iv = setInterval(load, 10_000);
    return () => {
      clearInterval(iv);
      es?.close();
    };
  }, [load]);

  /*
   * Which tokens have already been on screen.
   *
   * A row is only "new" the first time it is rendered, so this is a ref rather
   * than state — writing it must not itself cause a render, and the very first
   * load must not animate all 250 rows in at once, which reads as a glitch
   * rather than as arrivals.
   */
  const seen = useRef<Set<string>>(new Set());
  const primed = useRef(false);
  const all = useMemo(() => data?.rows ?? [], [data]);

  useEffect(() => {
    if (!all.length) return;
    if (!primed.current) {
      // First payload: everything counts as already seen.
      for (const r of all) seen.current.add(r.token);
      primed.current = true;
      return;
    }
    // Mark after paint, so this render still sees them as new.
    const t = setTimeout(() => {
      for (const r of all) seen.current.add(r.token);
      // The feed window is capped, so this cannot grow without bound, but a
      // long session still churns thousands of tokens through it.
      if (seen.current.size > 6000) {
        seen.current = new Set(all.map((r) => r.token));
      }
    }, 900);
    return () => clearTimeout(t);
  }, [all]);
  /*
   * Filters are read after mount, not during render: localStorage does not
   * exist on the server, and reading it while rendering would make the first
   * client paint disagree with the HTML it replaces.
   */
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  useEffect(() => setFilters(readFilters()), []);
  const applyFilters = useCallback((f: Filters) => {
    setFilters(f);
    writeFilters(f);
  }, []);
  const filterCount = activeCount(filters);

  /* Search first, then filters, so the count shown on the panel is "of what
     you searched" rather than of the whole feed. */
  const searched = useMemo(() => {
    const q = find.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (r) =>
        r.symbol.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        r.token.toLowerCase().includes(q),
    );
  }, [all, find]);

  const rows = useMemo(
    () => (filterCount === 0 ? searched : searched.filter((r) => passes(r, filters))),
    [searched, filters, filterCount],
  );

  return (
    <aside className="feed card glow">
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
            {all.length !== rows.length ? ` of ${all.length}` : ""}
          </span>
        </h2>
        <span
          className={`livedot${held ? " livedot-held" : ""}`}
          title={
            held
              ? "Held still while you move over the list — resumes a moment after you stop"
              : pushed
                ? "Pushed from the chain as launches land"
                : "Checking every 10s — the live connection is not up"
          }
        >
          <i />
          {held ? "paused" : pushed ? "live" : "polling"}
        </span>
        <div className="findwrap">
          <svg className="findicon" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M10.6 10.6 L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input
            ref={findRef}
            className="input feedfind"
            placeholder="Search tokens"
            value={find}
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setFind("")}
          />
          {/* The shortcut is shown because it exists, not as decoration. */}
          <kbd className="findkbd">{isMac ? "⌘ K" : "Ctrl K"}</kbd>
        </div>
        {/* The count on the button is the point of it: a filter you forgot you
            set looks exactly like a quiet market. */}
        <button
          className={`ff-btn${showFilters ? " open" : ""}${filterCount ? " on" : ""}`}
          onClick={() => setShowFilters((v) => !v)}
          aria-expanded={showFilters}
        >
          Filters
          {filterCount > 0 && <b>{filterCount}</b>}
        </button>
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

      {showFilters && (
        <FeedFilters
          filters={filters}
          onChange={applyFilters}
          matched={rows.length}
          total={searched.length}
        />
      )}

      <div
        className="flist"
        onPointerMove={hold}
        onMouseLeave={release}
        onWheel={release}
      >
        {/*
          The header lives inside the scrolling list, stuck to its top.

          Outside it, the rows sat in a scrolled box fifteen pixels narrower
          than the header did, so every numeric label was fifteen pixels right
          of the column it named — on the same grid, with the same tracks, and
          still not lining up. Inside, both share one width whatever the
          scrollbar does, and the header stays put while the feed moves.
        */}
        <div className="fhead">
          <span>Coin</span>
          <span className="ta-c">20m</span>
          <span className="ta-r">MC</span>
          <span className="ta-r">Vol</span>
          <span className="ta-r">Liq</span>
          <span className="ta-r">Tx</span>
        </div>
        {rows.length === 0 ? (
          <p className="muted small" style={{ margin: "10px 0" }}>
            {data ? "Nothing yet." : "Loading…"}
          </p>
        ) : (
          rows.map((r, i) => (
            <FeedRow
              key={r.token}
              r={r}
              onPick={onPick}
              eager={i < IMAGE_ROWS}
              fresh={!seen.current.has(r.token)}
            />
          ))
        )}
      </div>
    </aside>
  );
}
