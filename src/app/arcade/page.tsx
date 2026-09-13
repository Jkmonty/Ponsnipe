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
import { World, ROUND_MS, type Snapshot, type Stock } from "./world";
import { Sfx } from "./sfx";

interface BoardRow {
  wallet: string;
  name: string;
  points: number;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function ArcadePage() {
  const holder = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<World | null>(null);
  const sfxRef = useRef<Sfx | null>(null);
  /** Mirrors the game's scope state, so the overlay can follow it. */
  const [scoped, setScoped] = useState(false);

  const [stocks, setStocks] = useState<Stock[] | null>(null);
  const [s, setS] = useState<Snapshot | null>(null);
  const [board, setBoard] = useState<BoardRow[]>([]);
  const [wallet, setWallet] = useState("");
  const [posted, setPosted] = useState<string | null>(null);
  /** Whether the browser granted pointer lock. Aiming differs if it did not. */
  const [locked, setLocked] = useState(true);

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

  /** Give the canvas a CSS box; the renderer handles device pixels itself. */
  const fit = useCallback(() => {
    const el = holder.current;
    const cv = canvasRef.current;
    if (!el || !cv) return;
    const r = el.getBoundingClientRect();
    cv.style.width = `${r.width}px`;
    cv.style.height = `${Math.max(340, r.width * 0.58)}px`;
    gameRef.current?.resize();
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
    setLocked(true);
    // Audio can only start from a gesture, and this is one.
    sfxRef.current ??= new Sfx();
    sfxRef.current.resume();
    const g = new World(cv, stocks, setS);
    g.sfx = sfxRef.current;
    gameRef.current = g;
    /*
     * A handle on the running game.
     *
     * The loop is driven by requestAnimationFrame, which a browser does not
     * run while the page is not being painted — so a headless check can see
     * the page but never a single frame of the game. With this, the round can
     * be stepped and shot by hand from the console, which is the only way to
     * test the thing that actually goes wrong: whether a shot registers.
     */
    (window as unknown as { __arcade?: World }).__arcade = g;
    setScoped(false);
    setS(null);
    g.start();
    /*
     * Pointer lock if the browser will give it, and a fallback if not.
     *
     * Locked, mouse movement becomes head movement and the view keeps turning
     * past the edge of the window. Refused — some embedded contexts throw
     * WrongDocumentError outright — aiming falls back to cursor position, so
     * the game is still playable rather than unaimable. Never depend on a
     * permission the browser is free to decline.
     */
    try {
      const res = cv.requestPointerLock?.() as unknown as Promise<void> | undefined;
      if (res && typeof res.catch === "function") res.catch(() => setLocked(false));
    } catch {
      setLocked(false);
    }
  };

  /*
   * Believe the browser, not the request.
   *
   * requestPointerLock can be refused, or silently never take effect, and the
   * two aiming modes are completely different — one turns the view and shoots
   * down the middle, the other leaves the view still and shoots through the
   * cursor. Guessing wrong means every shot goes somewhere the player did not
   * point, so the mode is read from pointerLockElement whenever it changes.
   */
  useEffect(() => {
    const sync = () => {
      const on = document.pointerLockElement === canvasRef.current;
      setLocked(on);
      const g = gameRef.current;
      if (g) g.pointerAiming = !on;
    };
    document.addEventListener("pointerlockchange", sync);
    return () => document.removeEventListener("pointerlockchange", sync);
  }, []);

  useEffect(
    () => () => {
      gameRef.current?.stop();
      sfxRef.current?.close();
    },
    [],
  );

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

  /*
   * Relative movement while locked, absolute when not.
   *
   * Locked, movementX is the whole story. Unlocked, it still arrives but the
   * cursor stops at the edge of the canvas and so does the aim — so the
   * fallback steers towards wherever the cursor is instead, which keeps every
   * part of the range reachable.
   */
  /** Raise or lower the scope, keeping the game and the overlay in step. */
  const scope = (on: boolean) => {
    const g = gameRef.current;
    if (!g || g.scoped === on) return;
    g.setScoped(on);
    setScoped(g.scoped);
  };

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gameRef.current;
    const cv = canvasRef.current;
    if (!g || !cv) return;
    if (locked && document.pointerLockElement === cv) {
      g.look(e.movementX || 0, e.movementY || 0);
      return;
    }
    const r = cv.getBoundingClientRect();
    g.aimAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
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
          Sherwood Shooting Range — real tickers on the butts, and the ones down
          today shoot back.
        </span>
      </header>

      {/*
        The centre reticle is only honest in two of the three states: locked,
        where the view turns under a fixed crosshair, and scoped, where the
        shot goes down the middle whatever the cursor is doing. Free and
        unscoped, the cursor is the crosshair and a second one in the middle
        of the screen points at nothing.
      */}
      <div className={`arc-stage${locked || scoped ? "" : " arc-free"}`} ref={holder}>
        <canvas
          ref={canvasRef}
          className="arc-canvas"
          onPointerMove={move}
          onPointerDown={(e) => {
            /*
             * Hold right to raise the scope, left to loose.
             *
             * This used to hang off `contextmenu`, which was the bug: once
             * pointer lock is granted the browser stops dispatching that event
             * entirely, so the scope silently did nothing for anyone whose
             * browser granted the lock — which is everyone, on HTTPS. The
             * button is read from pointerdown instead, which always arrives.
             */
            if (e.button === 2) {
              scope(true);
              return;
            }
            if (e.button !== 0) return;
            move(e);
            gameRef.current?.fire();
          }}
          onPointerUp={(e) => e.button === 2 && scope(false)}
          onPointerLeave={() => scope(false)}
          onContextMenu={(e) => e.preventDefault()}
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
                <h1>Sherwood Shooting Range</h1>
                <p>
                  Move to look, click to loose, hold right to raise the scope.
                  Green butts are shares up today and worth points. Red ones are down
                  on the day, and they shoot back — three arrows and you are finished.
                </p>
                <button className="btn btn-primary btn-lg" onClick={play}>
                  Start
                </button>
              </>
            )}
          </div>
        )}

        {/*
          The scope, drawn over the canvas rather than inside it.
          
          The three-dimensional part of a scope is the narrower field of view,
          which the camera already does. What is left is the glass: everything
          outside the circle blacked out, a ring, and crosshairs. That is a
          border and two gradients, and doing it in CSS keeps it crisp at any
          size instead of being redrawn every frame.
        */}
        {live && scoped && <div className="arc-scope" aria-hidden="true" />}

        {live && (
          <>
            <div className="arc-hud">
              <span className="arc-score">{s.points.toLocaleString()}</span>
              {s.combo > 1 && <span className="arc-combo">×{s.combo}</span>}
              <span className="arc-time">{Math.ceil(s.msLeft / 1000)}s</span>
            </div>
            <div className="arc-health" aria-label={`Health ${s.health}%`}>
              <i style={{ width: `${Math.max(0, Math.min(100, s.health))}%` }} />
            </div>
          </>
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
