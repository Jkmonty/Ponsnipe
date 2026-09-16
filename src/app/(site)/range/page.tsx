"use client";

/**
 * The arcade: a scope, real tickers, and the ones having a bad day shoot back.
 *
 * This page owns starting and stopping the simulation and nothing else. The
 * game itself lives in game.ts and draws to a canvas, because a loop running
 * sixty times a second has no business being React state.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Butt from "../Butt";
import { World, ROUND_MS, type Snapshot, type Stock } from "./world";
import { makeSurface } from "./render";
import { Sfx } from "./sfx";

interface BoardRow {
  wallet: string;
  name: string;
  points: number;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** "Mon 15 Sep · 00:00 UTC". Always a Monday midnight by construction. Kept
    in step with the same label on the hero's board card. */
const endsLabel = (endsAt: number) => {
  const day = new Date(endsAt).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  return `${day} · 00:00 UTC`;
};

export default function ArcadePage() {
  const holder = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<World | null>(null);
  const sfxRef = useRef<Sfx | null>(null);
  /** Mirrors the game's scope state, so the overlay can follow it. */
  const [scoped, setScoped] = useState(false);
  /** The hit marker: which hit it belongs to, and whether it was a red one. */
  const [mark, setMark] = useState<{ n: number; kill: boolean } | null>(null);

  const [stocks, setStocks] = useState<Stock[] | null>(null);
  const [s, setS] = useState<Snapshot | null>(null);
  const [board, setBoard] = useState<BoardRow[]>([]);
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [wallet, setWallet] = useState("");
  const [posted, setPosted] = useState<string | null>(null);
  /** Whether the browser granted pointer lock. Aiming differs if it did not. */
  const [locked, setLocked] = useState(true);
  /** False only if building the `World` threw — no WebGL context, a driver
      blocklist, an Android WebView, too many live contexts. The stage falls
      back to a line of text and the leaderboard below is untouched; without
      this the throw would escape the mount effect straight to the route's
      default error boundary and take the board down with it. */
  const [webgl, setWebgl] = useState(true);

  useEffect(() => {
    void fetch("/api/arcade/targets")
      .then((r) => r.json())
      .then((j: { targets?: Stock[] }) => setStocks(j.targets ?? []))
      .catch(() => setStocks([]));
    void fetch("/api/arcade")
      .then((r) => r.json())
      .then((j: { top?: BoardRow[]; endsAt?: number }) => {
        setBoard(j.top ?? []);
        setEndsAt(j.endsAt ?? null);
      })
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
    gameRef.current?.resize(cv.clientWidth, cv.clientHeight);
  }, []);

  useEffect(() => {
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [fit]);

  /*
   * Build the world once the targets are in, and run it in attract mode
   * straight away — the range is lit and moving under the menu from the
   * moment the page is ready, rather than a dead canvas waiting for Start.
   *
   * The same `World` carries on from here through however many rounds get
   * played: `play()` below calls `start()` on this instance rather than
   * building a fresh one, so the wood is never torn down and rebuilt
   * between attract and a real round, or between "Again" and the next one.
   */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !stocks || gameRef.current) return;
    fit();
    /*
     * A missing WebGL context throws out of `new T.WebGLRenderer`, inside
     * `makeSurface` — no WebGL, a driver blocklist, an Android WebView, too
     * many live contexts already open. This effect is where that throw
     * would otherwise land: React sends an effect's throw to the nearest
     * error boundary, and there is no `error.tsx` under this route, so the
     * default boundary would replace the whole page — leaderboard included.
     * Catching it here and falling back to a line of text is what keeps the
     * board standing.
     */
    let g: World;
    try {
      g = new World(makeSurface(cv), stocks, setS);
    } catch {
      setWebgl(false);
      return;
    }
    gameRef.current = g;
    // `fit()` above already gave the canvas its real CSS box; hand World
    // those same measurements now that it exists, rather than the 960×560
    // default it builds with — the one resize a fresh World used to do
    // itself, reading `canvas.clientWidth` at the end of its own
    // constructor.
    g.resize(cv.clientWidth, cv.clientHeight);
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
    g.attract();
  }, [stocks, fit]);

  const play = () => {
    const cv = canvasRef.current;
    const g = gameRef.current;
    if (!cv || !g || !stocks?.length) return;
    fit();
    setPosted(null);
    setLocked(true);
    // Audio can only start from a gesture, and this is one.
    sfxRef.current ??= new Sfx();
    sfxRef.current.resume();
    // The wind and the drone are a round's ambience, not "the context is
    // unlocked" — resume() no longer starts them itself (see sfx.ts), so
    // Start and Again both have to ask for them explicitly.
    sfxRef.current.roundStart();
    g.sfx = sfxRef.current;
    setScoped(false);
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
      // Without this a disposed World — and its whole scene graph, wood
      // included — stays reachable from both the ref and window.__arcade
      // after unmount, which is not what "stop" is supposed to mean.
      gameRef.current = null;
      (window as unknown as { __arcade?: World | null }).__arcade = null;
      sfxRef.current?.close();
    },
    [],
  );

  /*
   * Stop paying for a shadow pass and a full-resolution render on pixels
   * nobody can see: a visitor reading the board below the stage, or a menu
   * left open on a phone in a pocket. `World.setActive` only starts or stops
   * the render loop — `runLoop` is idempotent and `stop()` remains the one
   * real teardown, called only on unmount above.
   */
  useEffect(() => {
    const el = holder.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => gameRef.current?.setActive(entry.isIntersecting), {
      threshold: 0,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /*
   * Flash the hit marker.
   *
   * The game bumps a counter on every hit rather than calling out, so this is
   * driven by the same snapshot as everything else. Keying the timer on the
   * counter means two hits in quick succession restart the flash instead of
   * the second one being swallowed by the first one's timeout.
   */
  useEffect(() => {
    if (!s?.mark) return;
    setMark({ n: s.mark, kill: s.markKill });
    const id = setTimeout(() => setMark(null), 220);
    return () => clearTimeout(id);
  }, [s?.mark, s?.markKill]);

  /*
   * Fade the wind and the drone out the moment a round ends — not tied to
   * `posted`, which is about the score POST firing once, not the ambience.
   * `roundEnd()` no-ops harmlessly if called again on a re-render.
   */
  useEffect(() => {
    if (s?.over) sfxRef.current?.roundEnd();
  }, [s?.over]);

  /* Post the run once, when the round ends. */
  useEffect(() => {
    if (!s?.over || posted) return;
    // The result card is what this phase actually shipped, and it is dead
    // until this: while the pointer stays locked, the cursor is hidden and
    // every click goes to the canvas underneath, not the card's own Again
    // button. A no-op if nothing was locked in the first place.
    document.exitPointerLock?.();
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
      .then((j: { top?: BoardRow[]; endsAt?: number }) => {
        setBoard(j?.top ?? []);
        setEndsAt(j?.endsAt ?? null);
      })
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

  // Not live while attracting either: no round has started, so the HUD
  // (score, health, hit marker) has nothing real to show.
  const live = s && !s.over && !s.attract;

  return (
    <main className="arc range">
      <div className="range-head">
        <Butt size={44} />
        <div>
          <h1 className="display">Sherwood Shooting Range</h1>
          <p>Real tickers on the butts, and the ones down today shoot back.</p>
        </div>
      </div>

      <div className="range-body">

        {/*
          The centre reticle is only honest in two of the three states: locked,
          where the view turns under a fixed crosshair, and scoped, where the
          shot goes down the middle whatever the cursor is doing. Free and
          unscoped, the cursor is the crosshair and a second one in the middle
          of the screen points at nothing.
        */}
        <div className={`arc-stage${locked || scoped ? "" : " arc-free"}`} ref={holder}>
          {!webgl && (
            // The spec's own failure table: WebGL missing shows a painted
            // stage and a line saying so, and the board below is unaffected —
            // nothing here ever touches gameRef, stocks or the board state.
            // The canvas underneath is left alone rather than hidden: it is
            // what gives .arc-stage its height (fit() sizes it in CSS pixels
            // regardless of whether a context could be attached to it, and
            // this overlay, like every other one here, is `position:
            // absolute; inset: 0` and so cannot supply that height itself —
            // hiding the canvas collapsed the whole stage to nothing).
            <div className="arc-overlay">
              <p className="arc-card arc-card-load">
                This range needs WebGL, which this browser or device is not giving it. The
                leaderboard below still works.
              </p>
            </div>
          )}
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
              /*
               * A finger is also the aim, so there is no holding a draw on
               * touch without losing the thing you were aiming at — one tap
               * looses immediately, at a solid fixed pull. A mouse can hold
               * still while the button is down, so it gets the real draw:
               * begin it here, and loose it on release below.
               */
              if (e.pointerType === "touch") {
                gameRef.current?.touchFire();
              } else {
                gameRef.current?.beginDraw();
              }
            }}
            onPointerUp={(e) => {
              if (e.button === 2) {
                scope(false);
                return;
              }
              if (e.button === 0 && e.pointerType !== "touch") gameRef.current?.releaseDraw();
            }}
            onPointerLeave={() => {
              scope(false);
              // The cursor leaving mid-draw must never loose a shot — that is
              // exactly the stray input the draw threshold exists to filter
              // out of clicks, just reached by drifting off the canvas
              // instead. cancelDraw throws the hold away unconditionally,
              // rather than releaseDraw's loose-if-far-enough.
              gameRef.current?.cancelDraw();
            }}
            onContextMenu={(e) => e.preventDefault()}
          />

          {webgl && (!s || s.over || s.attract) && (
            <div className="arc-overlay">
              {!stocks ? (
                <p className="arc-card arc-card-load">loading targets…</p>
              ) : !stocks.length ? (
                <p className="arc-card arc-card-load">No stock targets available right now.</p>
              ) : (
                <div className="arc-card">
                  <p className="lab arc-card-lab">Sherwood · Robinhood Chain</p>
                  {s?.over ? (
                    <>
                      <h1 className="display arc-card-title">{s.points.toLocaleString()}</h1>
                      <p className="arc-card-rules">
                        {s.hits} hits from {s.shots} shots
                      </p>
                      {posted && <p className="arc-posted">{posted}</p>}
                    </>
                  ) : (
                    <>
                      <h1 className="display arc-card-title">Sherwood, last light.</h1>
                      <p className="arc-card-rules">
                        Move to look, click to loose, hold right to raise the scope. Green
                        butts are shares up today and worth points. Red ones are down on
                        the day, and they shoot back — three arrows and you are finished.
                      </p>
                    </>
                  )}

                  <div className="arc-chips">
                    {stocks.slice(0, 8).map((t) => (
                      <span key={t.symbol} className={`arc-chip ${t.changePct >= 0 ? "up" : "down"}`}>
                        <b>{t.symbol}</b>
                        {t.changePct >= 0 ? "+" : ""}
                        {t.changePct.toFixed(1)}%
                      </span>
                    ))}
                  </div>

                  {board.length > 0 && (
                    <div className="arc-top3">
                      <div className="arc-top3-h lab">
                        <span>This week</span>
                        {endsAt !== null && <span className="gold">ends {endsLabel(endsAt)}</span>}
                      </div>
                      <ol>
                        {board.slice(0, 3).map((r, i) => (
                          <li key={r.wallet}>
                            <span className="n mono">{i + 1}</span>
                            <span className="w mono">{r.name || short(r.wallet)}</span>
                            <span className="p num">{r.points.toLocaleString()}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  <button className="btn btn-primary btn-lg" onClick={play}>
                    {s?.over ? "Again" : "Draw the bow"}
                  </button>
                  <p className="arc-controls mono">
                    <span className="ctl-mouse">HOLD TO DRAW · RELEASE TO LOOSE · RIGHT-CLICK FOR THE SCOPE</span>
                    <span className="ctl-touch">TAP TO FIRE · DRAG TO AIM</span>
                  </p>
                </div>
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

          {/*
            Being shot, made obvious.

            A number dropping in the corner is not something you notice while
            you are looking down the middle of the screen for the next target,
            which is exactly when you are being shot at. Red closing in from the
            edges is in your peripheral vision whether you look at it or not —
            and it stays faintly on once the bar is nearly empty, so "nearly
            dead" is a state you can feel rather than a figure you have to check.
          */}
          {live && (s.hurt > 0 || s.health <= 34) && (
            <div
              className="arc-damage"
              aria-hidden="true"
              style={{ opacity: Math.max(s.hurt, s.health <= 34 ? 0.3 : 0) }}
            />
          )}

          {/*
            The hit marker, at the centre of the view where the shot went. Keyed
            by the hit counter so the animation restarts on every hit rather
            than playing once and sitting still through a run of them.
          */}
          {live && mark && (
            <div
              key={mark.n}
              className={`arc-mark${mark.kill ? " kill" : ""}`}
              aria-hidden="true"
            />
          )}

          {live && (
            <>
              <div className="arc-hud">
                <span className="arc-score">{s.points.toLocaleString()}</span>
                {/*
                  Keyed by the combo's own value, so each increment remounts
                  the span and restarts the CSS pop rather than the number
                  just quietly changing underneath a static element.
                */}
                {s.combo > 1 && (
                  <span key={s.combo} className="arc-combo">
                    ×{s.combo}
                  </span>
                )}
                <span className="arc-time">{Math.ceil(s.msLeft / 1000)}s</span>
              </div>
              <div className="arc-health" aria-label={`Health ${s.health}%`}>
                <i style={{ width: `${Math.max(0, Math.min(100, s.health))}%` }} />
              </div>
              {/*
                The draw meter: only on screen while actually drawing, so an
                idle view is not cluttered by an empty bar sitting there doing
                nothing.
              */}
              {s.draw > 0 && (
                <div className="arc-draw" aria-hidden="true">
                  <i style={{ width: `${Math.round(Math.max(0, Math.min(1, s.draw)) * 100)}%` }} />
                </div>
              )}
            </>
          )}
        </div>

        <section className="arc-board" id="board">
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
      </div>
    </main>
  );
}
