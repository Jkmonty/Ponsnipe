"use client";

/**
 * The price chart for the coin currently picked.
 *
 * Drawn by hand in SVG rather than pulling in a charting library, for the same
 * reason the feed's sparkline is: this needs a line, an area, volume bars and
 * a crosshair, all of which are a few dozen lines of geometry, and a library
 * would cost more in bundle than the whole rest of the panel.
 *
 * The data behind it is the feed sweep's own price history — five-second
 * closes for two hours, minute closes for twelve — so opening a chart costs
 * one query against a table we already keep, not a call to anybody.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface Point {
  t: number;
  p: number;
}
interface Bar {
  t: number;
  q: number;
  b: number;
  s: number;
}
interface History {
  res: string;
  step: number;
  indexed: boolean;
  launchedAt?: string;
  points: Point[];
  vol?: Bar[];
}

/** The windows on offer, and how far back each looks. */
const RANGES = [
  { label: "5m", minutes: 5 },
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "12h", minutes: 720 },
] as const;

const W = 340;
const H = 132;
const VOL_H = 26;
const PAD_T = 8;
const PLOT_H = H - VOL_H - PAD_T - 2;

/**
 * A price with eight leading zeros, written so a human can read it.
 *
 * These coins price in the 1e-9 range, where "0.00000000123" is a wall of
 * zeros nobody counts correctly. The subscript form is what every exchange
 * settled on for the same reason.
 */
function tinyPrice(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "—";
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.001) return p.toFixed(6);
  const zeros = Math.floor(-Math.log10(p)) - 1;
  const digits = Math.round(p * 10 ** (zeros + 4))
    .toString()
    .slice(0, 4);
  const sub = "₀₁₂₃₄₅₆₇₈₉";
  const mark = String(zeros)
    .split("")
    .map((d) => sub[Number(d)])
    .join("");
  return `0.0${mark}${digits}`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export default function Chart({ address, symbol }: { address: string; symbol: string }) {
  const [minutes, setMinutes] = useState<number>(15);
  const [hist, setHist] = useState<History | null>(null);
  const [err, setErr] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/token/history?address=${address}&minutes=${minutes}`);
      const j = (await r.json()) as History;
      if (!r.ok) throw new Error("history failed");
      setHist(j);
      setErr(false);
    } catch {
      setErr(true);
    }
  }, [address, minutes]);

  /*
   * Reloaded on a timer rather than pushed. The feed's stream carries new
   * launches, not price ticks, and a coin whose chart is open is one coin —
   * a three-second poll of one small query is cheaper than another stream.
   */
  useEffect(() => {
    setHist(null);
    // The crosshair is an index into the old series. Kept across a range
    // change it would point at a different minute and read as a wrong price.
    setHover(null);
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);

  const pts = useMemo(() => hist?.points ?? [], [hist]);

  const geom = useMemo(() => {
    if (pts.length < 2) return null;
    const lo = Math.min(...pts.map((p) => p.p));
    const hi = Math.max(...pts.map((p) => p.p));
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const span = Math.max(1, t1 - t0);
    // A flat line would divide by zero and then sit on the floor of the box.
    const pad = hi === lo ? Math.max(hi * 0.02, Number.MIN_VALUE) : (hi - lo) * 0.12;
    const top = hi + pad;
    const bot = Math.max(0, lo - pad);
    const x = (t: number) => ((t - t0) / span) * W;
    const y = (p: number) => PAD_T + PLOT_H - ((p - bot) / Math.max(top - bot, 1e-30)) * PLOT_H;
    const line = pts
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(2)},${y(p.p).toFixed(2)}`)
      .join(" ");
    const area = `${line} L${W},${PAD_T + PLOT_H} L0,${PAD_T + PLOT_H} Z`;
    return { lo, hi, t0, t1, x, y, line, area };
  }, [pts]);

  const change = pts.length >= 2 ? (pts[pts.length - 1].p / pts[0].p - 1) * 100 : 0;
  const up = change >= 0;

  const bars = useMemo(() => {
    const v = hist?.vol ?? [];
    if (!v.length || !geom) return [];
    const peak = Math.max(...v.map((b) => b.q)) || 1;
    /*
     * Width comes from the minute a bar covers, not from how many bars there
     * are. Dividing by the count drew one bar the width of the whole chart
     * when a coin had traded in a single minute — a solid block of colour that
     * looked like a filled background rather than a volume bar.
     */
    const span = Math.max(60_000, geom.t1 - geom.t0);
    const wide = Math.max(1.5, Math.min(14, (W * 60_000) / span - 1));
    return v
      .filter((b) => b.t >= geom.t0 - 60_000 && b.t <= geom.t1 + 60_000)
      .map((b) => ({
        x: Math.max(0, Math.min(W - wide, geom.x(b.t) - wide / 2)),
        w: wide,
        h: Math.max(1, (b.q / peak) * VOL_H),
        // Coloured by which side did more, which is the only thing a bar this
        // small can usefully say.
        buy: b.b >= b.s,
      }));
  }, [hist, geom]);

  /** Nearest point to the pointer, in data terms rather than pixels. */
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const el = svgRef.current;
    if (!el || !geom || pts.length < 2) return;
    const r = el.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const t = geom.t0 + frac * (geom.t1 - geom.t0);
    let best = 0;
    for (let i = 1; i < pts.length; i++) {
      if (Math.abs(pts[i].t - t) < Math.abs(pts[best].t - t)) best = i;
    }
    setHover(best);
  };

  const cursor = hover != null && pts[hover] ? pts[hover] : null;

  return (
    <div className="ch">
      <div className="ch-head">
        <div className="ch-now">
          <span className="ch-price mono">{tinyPrice(pts[pts.length - 1]?.p ?? 0)}</span>
          {pts.length >= 2 && (
            <span className={`ch-chg ${up ? "up" : "down"}`}>
              {up ? "+" : ""}
              {change.toFixed(change > 999 ? 0 : 1)}%
            </span>
          )}
        </div>
        <div className="ch-ranges">
          {RANGES.map((r) => (
            <button
              key={r.label}
              className={`ch-r${minutes === r.minutes ? " on" : ""}`}
              onClick={() => setMinutes(r.minutes)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {!hist ? (
        <div className="ch-box ch-empty">loading…</div>
      ) : err ? (
        <div className="ch-box ch-empty">history unavailable</div>
      ) : pts.length < 2 ? (
        /* Said plainly. Half of all launches never trade, and a chart with one
           point is not a quiet chart, it is no chart. */
        <div className="ch-box ch-empty">
          {hist.indexed
            ? "Not enough trades yet to draw a line."
            : "Older than the feed window — no history kept."}
        </div>
      ) : (
        <>
          <svg
            ref={svgRef}
            className="ch-svg"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            <defs>
              <linearGradient id="chfill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={up ? "var(--up)" : "var(--down)"} stopOpacity="0.28" />
                <stop offset="100%" stopColor={up ? "var(--up)" : "var(--down)"} stopOpacity="0" />
              </linearGradient>
            </defs>

            {geom && (
              <>
                <path d={geom.area} fill="url(#chfill)" />
                <path
                  d={geom.line}
                  fill="none"
                  stroke={up ? "var(--up)" : "var(--down)"}
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              </>
            )}

            {bars.map((b, i) => (
              <rect
                key={i}
                x={b.x}
                y={H - b.h}
                width={b.w}
                height={b.h}
                fill={b.buy ? "var(--up)" : "var(--down)"}
                opacity="0.45"
              />
            ))}

            {cursor && geom && (
              <g>
                <line
                  x1={geom.x(cursor.t)}
                  y1={0}
                  x2={geom.x(cursor.t)}
                  y2={H}
                  stroke="var(--line-2)"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
                <circle
                  cx={geom.x(cursor.t)}
                  cy={geom.y(cursor.p)}
                  r="2.5"
                  fill={up ? "var(--up)" : "var(--down)"}
                />
              </g>
            )}
          </svg>

          <div className="ch-foot">
            {cursor ? (
              <>
                <span className="mono">{tinyPrice(cursor.p)}</span>
                <span>{clock(cursor.t)}</span>
              </>
            ) : (
              <>
                <span>
                  {symbol} · {hist.res === "5s" ? "5s" : "1m"} steps
                </span>
                <span>{clock(pts[0].t)} → now</span>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
