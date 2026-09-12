"use client";

/**
 * The arcade: a scope, real tickers, and the ones having a bad day shoot back.
 *
 * This page owns starting and stopping the simulation and nothing else. The
 * game itself lives in game.ts and draws to a canvas, because a loop running
 * sixty times a second has no business being React state.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Logo from "../Logo";
import { Arcade, ROUND_MS, type Snapshot, type Stock } from "./game";

interface BoardRow {
  wallet: string;
  name: string;
  points: number;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function ArcadePage() {
  const holder = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Arcade | null>(null);

  const [stocks, setStocks] = useState<Stock[] | null>(null);
  const [s, setS] = useState<Snapshot | null>(null);
  const [board, setBoard] = useState<BoardRow[]>([]);
  const [wallet, setWallet] = useState("");
  const [posted, setPosted] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/arcade/targets")
      .then((r) => r.json())
      .then((j: { targets?: Stock[] }) => setStocks(j.targets ?? []))
      .catch(() => setStocks([]));
    void fetch("/api/arcade")
      .then((r) => r.json())
      .then((j: { top?: BoardRow[] }) => setBoard(j.top ?? []))
      .catch(() => {});
    // The wallet is only an address to send a prize to, so the one already in
    // this browser is the obvious default and nobody has to type anything.
    try {
      const v = localStorage.getItem("ponsnipe.tradingKey.v1");
      const parsed = v ? (JSON.parse(v) as { addresses?: string[]; address?: string }) : null;
      setWallet(parsed?.addresses?.[0] ?? parsed?.address ?? "");
    } catch {
      /* no wallet yet, which is fine until there is a prize to claim */
    }
  }, []);

  /** Size the canvas to its box, in device pixels, so nothing is blurry. */
  const fit = useCallback(() => {
    const el = holder.current;
    const cv = canvasRef.current;
    if (!el || !cv) return;
    const r = el.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(r.width * dpr);
    cv.height = Math.round(Math.max(320, r.width * 0.62) * dpr);
    cv.style.height = `${cv.height / dpr}px`;
  }, []);

  useEffect(() => {
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [fit]);

  const play = () => {
    const cv = canvasRef.current;
    if (!cv || !stocks?.length) return;
    fit();
    gameRef.current?.stop();
    setPosted(null);
    const g = new Arcade(cv, stocks, setS);
    g.aim = { x: cv.width / 2, y: cv.height / 2 };
    gameRef.current = g;
    setS(null);
    g.start();
  };

  useEffect(() => () => gameRef.current?.stop(), []);

  /* Post the run once, when the round ends. */
  useEffect(() => {
    if (!s?.over || posted) return;
    const g = gameRef.current;
    if (!g) return;
    setPosted("sending");
    void fetch("/api/arcade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        wallet,
        name: "",
        points: g.points,
        hits: g.hits,
        shots: g.shots,
        ms: ROUND_MS - Math.max(0, g.msLeft),
      }),
    })
      .then((r) => r.json())
      .then((j: { rank?: number; improved?: boolean; error?: string }) => {
        setPosted(
          j.error
            ? j.error
            : j.improved
              ? `Ranked #${j.rank ?? "?"} this week`
              : `Your best this week still stands`,
        );
        return fetch("/api/arcade").then((r) => r.json());
      })
      .then((j: { top?: BoardRow[] }) => setBoard(j?.top ?? []))
      .catch(() => setPosted("could not post that score"));
  }, [s?.over, posted, wallet]);

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gameRef.current;
    const cv = canvasRef.current;
    if (!g || !cv) return;
    const r = cv.getBoundingClientRect();
    g.aim = {
      x: ((e.clientX - r.left) / r.width) * cv.width,
      y: ((e.clientY - r.top) / r.height) * cv.height,
    };
  };

  const live = s && !s.over;

  return (
    <main className="arc">
      <header className="arc-top">
        <Link href="/" className="arc-home">
          <Logo size={26} />
          <span>Ponsnipe</span>
        </Link>
        <span className="arc-sub">
          Sherwood. Real tickers on the butts — the ones down today shoot back.
        </span>
      </header>

      <div className="arc-stage" ref={holder}>
        <canvas
          ref={canvasRef}
          className="arc-canvas"
          onPointerMove={move}
          onPointerDown={(e) => {
            if (e.button === 2) return;
            move(e);
            gameRef.current?.fire();
          }}
          onContextMenu={(e) => {
            // Right-click zooms rather than opening a menu, which is what a
            // scope does and what anybody who has played one expects.
            e.preventDefault();
            const g = gameRef.current;
            if (g) g.zoomed = !g.zoomed;
          }}
        />

        {(!s || s.over) && (
          <div className="arc-overlay">
            {!stocks ? (
              <p>loading targets…</p>
            ) : !stocks.length ? (
              <p>No stock targets available right now.</p>
            ) : s?.over ? (
              <>
                <h1>{s.points.toLocaleString()}</h1>
                <p>
                  {s.hits} hits from {s.shots} shots
                  {s.shots > 0 && ` · ${Math.round((s.hits / s.shots) * 100)}%`}
                </p>
                {posted && <p className="arc-posted">{posted}</p>}
                <button className="btn btn-primary btn-lg" onClick={play}>
                  Again
                </button>
              </>
            ) : (
              <>
                <h1>The greenwood</h1>
                <p>
                  Click to loose, right-click to steady the scope. Green butts are
                  shares up today and worth points. Red ones are down, and they shoot
                  back.
                </p>
                <button className="btn btn-primary btn-lg" onClick={play}>
                  Start
                </button>
              </>
            )}
          </div>
        )}

        {live && (
          <div className="arc-hud">
            <span className="arc-score">{s.points.toLocaleString()}</span>
            <span className="arc-lives">{"●".repeat(Math.max(0, s.lives))}</span>
            {s.combo > 1 && <span className="arc-combo">×{s.combo}</span>}
            <span className="arc-time">{Math.ceil(s.msLeft / 1000)}s</span>
          </div>
        )}
      </div>

      <section className="arc-board">
        <h2>This week</h2>
        {board.length === 0 ? (
          <p className="arc-empty">Nobody has posted a score yet.</p>
        ) : (
          <ol className="arc-rows">
            {board.slice(0, 20).map((r, i) => (
              <li key={r.wallet} className={r.wallet.toLowerCase() === wallet.toLowerCase() ? "me" : ""}>
                <span className="arc-rank">{i + 1}</span>
                <span className="mono">{r.name || short(r.wallet)}</span>
                <span className="arc-pts num">{r.points.toLocaleString()}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
