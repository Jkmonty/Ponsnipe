"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtEth, fmtPct, fmtPrice, shortAddr, weiToUnits, EXPLORER } from "@/lib/format";
import LaunchComposer from "./LaunchComposer";
import Logo from "./Logo";
import Feed from "./Feed";
import TradePanel from "./TradePanel";
import WalletSetup from "./WalletSetup";

interface WalletInfo {
  /** Set by a read-only instance: show the feed, hide everything that trades. */
  publicMode?: boolean;
  configured: boolean;
  address?: string;
  /** null when the balance could not be read; that is not the same as zero. */
  eth?: string | null;
  /** Set when the keystore is present but the chain read failed. */
  balanceError?: string;
}
interface TokenSnap {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  curve: string | null;
  quoteSymbol: string;
  quoteIsNative: boolean;
  feeBps: number;
  creatorTaxBps: number;
  price: { priceQuote: number };
  fdvQuote: number;
  tradeable: boolean;
  reason?: string;
  graduation: { graduated: boolean; progressPct: number; currentQuote: number; thresholdQuote: number };
}
interface Position {
  id: string;
  status: string;
  token_address: string;
  token_symbol: string;
  token_decimals: number;
  quote_symbol: string;
  quote_in_wei: string;
  tokens_held_wei: string;
  entry_price: number;
  current_price: number;
  pnl_pct: number;
  take_profit_pct: number | null;
  stop_loss_pct: number | null;
  trailing_stop_pct: number | null;
  graduation_exit_pct: number | null;
  sell_tx: string | null;
  close_reason: string | null;
  error: string | null;
  created_at: string;
}
interface EngineInfo {
  status: {
    running: boolean;
    live: boolean;
    ticks: number;
    lastError: string | null;
    watching?: number;
    rpcLagMs?: number | null;
    rpcSlow?: boolean;
    pollingMs?: number;
    transport?: "websocket" | "http";
  };
  recentLog: { ts: string; level: string; message: string }[];
}

const PRESETS = {
  safe: { label: "Safe", tp: 25, sl: 15 },
  balanced: { label: "Balanced", tp: 50, sl: 25 },
  moon: { label: "Moonshot", tp: 150, sl: 50 },
} as const;
type Mode = keyof typeof PRESETS | "custom";

/** Where to send people who want to run their own copy. Unset = no link. */
const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL?.trim() || "";

export default function Dashboard() {
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * Set when a coin is clicked in the feed. Carries a nonce as well as the
   * address so that re-picking the SAME coin still re-triggers the lookup —
   * with the address alone the effect would not fire the second time.
   */
  const [picked, setPicked] = useState<{ address: string; n: number } | null>(null);

  const flash = useCallback((kind: "ok" | "err", msg: string) => {
    setToast({ kind, msg });
    setTimeout(() => setToast(null), 7000);
  }, []);

  /*
   * Three independent reads, settled independently.
   *
   * Promise.all meant one failing endpoint rejected the lot and the catch
   * swallowed it, so a positions read that errored would leave `wallet` null
   * — and a null wallet renders "set up your trading wallet" at somebody who
   * has funds in one. Nothing here depends on anything else here.
   */
  const refresh = useCallback(async () => {
    const [w, e, p] = await Promise.allSettled([
      fetch("/api/wallet").then((r) => r.json()),
      fetch("/api/engine").then((r) => r.json()),
      fetch("/api/positions").then((r) => r.json()),
    ]);
    if (w.status === "fulfilled") setWallet(w.value);
    if (e.status === "fulfilled") setEngine(e.value);
    if (p.status === "fulfilled") setPositions(p.value?.positions ?? []);
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 4000);
    return () => clearInterval(iv);
  }, [refresh]);

  const post = useCallback(
    (path: string, body?: unknown) =>
      fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    [],
  );

  const createWallet = async (privateKey?: string) => {
    setBusy("wallet");
    try {
      const r = await post("/api/wallet/create", privateKey ? { privateKey } : undefined);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "could not create wallet");
      flash("ok", `${privateKey ? "Wallet imported" : "Wallet created"}: ${j.address}`);
      refresh();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(null);
    }
  };

  const toggleLive = async (next: boolean) => {
    if (next && !confirm("Live trading sends REAL transactions from your bot wallet. Continue?")) {
      return;
    }
    setBusy("live");
    try {
      const r = await post("/api/engine/live", { live: next });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "failed");
      flash("ok", next ? "Live trading is ON." : "Back to dry-run (no real trades).");
      refresh();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(null);
    }
  };

  const act = async (id: string, kind: "close" | "cancel") => {
    setBusy(id);
    try {
      const r = await fetch(
        kind === "close" ? `/api/positions/${id}/close` : `/api/positions/${id}`,
        { method: kind === "close" ? "POST" : "DELETE" },
      );
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "failed");
      flash("ok", kind === "close" ? "Sold." : "Stopped watching this position.");
      refresh();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(null);
    }
  };

  const live = engine?.status.live ?? false;
  const funded = wallet?.configured && Number(wallet.eth ?? 0) > 0;
  const open = positions.filter((p) => p.status === "open" || p.status === "closing");
  const history = positions.filter((p) => !(p.status === "open" || p.status === "closing"));

  return (
    <div className="wrap">
      <header className="topbar">
        <div className="row" style={{ gap: 0, minWidth: 0 }}>
          <div className="lockup">
            <Logo size={32} />
            <h1>Ponsnipe</h1>
          </div>
          <p className="sub">Pick your target. Take the shot. Walk away.</p>
        </div>
        <div className="row" style={{ gap: 10 }}>
          {/* A read-only instance has nothing to switch, and offering the
              switch anyway just produces a 401 at whoever presses it. */}
          {wallet?.publicMode ? (
            /*
              Links to the repo only when there is a repo to link to.
              This was hardcoded to https://github.com — a placeholder that
              shipped, and sent anyone who clicked it to the GitHub homepage.
              Set NEXT_PUBLIC_REPO_URL to turn it back into a link.
            */
            REPO_URL ? (
              <a
                className="chip chip-off"
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                title="Run your own copy, with your own wallet"
              >
                SOURCE
              </a>
            ) : (
              <span className="chip chip-off">READ-ONLY</span>
            )
          ) : (
            <>
          <span className={live ? "chip chip-live" : "chip chip-dry"}>
            <span className="dot" />
            {live ? "LIVE" : "DRY-RUN"}
          </span>
          <button
            className="switch"
            data-on={live}
            disabled={busy === "live" || !wallet?.configured}
            onClick={() => toggleLive(!live)}
            title={live ? "Switch to dry-run" : "Enable live trading"}
          />
            </>
          )}
        </div>
      </header>

      {engine?.status.rpcSlow && (
        <div
          className="card"
          style={{ padding: "12px 16px", borderColor: "#6b5a2f", color: "var(--amber)" }}
        >
          <strong>Your RPC is lagging {(engine.status.rpcLagMs! / 1000).toFixed(1)}s.</strong>{" "}
          <span className="muted small">
            Exits can only be as fast as new prices arrive. Set <span className="mono">RPC_URL</span>{" "}
            in <span className="mono">.env</span> to a private endpoint (e.g. Alchemy) for
            near‑instant reaction, then restart.
          </span>
        </div>
      )}

      {/*
        Two columns: the feed is what you watch, the right-hand column is what
        you do about it. Clicking a coin fills in the buy form rather than
        making you copy an address between two panels.
      */}
      {/*
        A read-only instance shows the feed and stops there.
        
        Every route that moves funds already refuses a remote request without
        ENGINE_API_TOKEN, so this is not the thing keeping a hosted instance
        safe — it is the thing that stops it looking broken. Rendering a wallet
        card, a buy form and a sniper switch that all 401 on touch reads as a
        failure rather than as a deliberate shop window.
      */}
      {wallet?.publicMode ? (
        <div className="cols cols-solo">
          <Feed onPick={(address) => setPicked({ address, n: Date.now() })} />
          <div className="colside">
            <TradePanel
              picked={picked}
              onPickHolding={(address) => setPicked({ address, n: Date.now() })}
            />
            <aside className="card">
              <h2 className="shead">What this is</h2>
              <p className="ssub" style={{ marginLeft: 13 }}>
                Every pons launch as it happens, with price charts, holder counts and how much
                of each crowd is one operator wearing several wallets.
              </p>
              <p className="muted small" style={{ marginLeft: 13, marginBottom: 0 }}>
                This site holds no wallet and no keys — trades are signed by you, in your own
                wallet. For take-profit and stop-loss that keep working after you close the
                tab, run your own copy: that needs a key on your machine, which no website can
                have.
              </p>
            </aside>
          </div>
        </div>
      ) : (
      <div className="cols">
        <Feed onPick={(address) => setPicked({ address, n: Date.now() })} />

        <div className="colmain">
      {/* ── setup / wallet ─────────────────────────────────────────── */}
      {/*
        The stepper is shown while setup is incomplete, because a card headed
        "Step 2" with no Step 1 anywhere on the page reads as something failing
        to render rather than as something already done.
      */}
      {wallet !== null && !funded && <Steps done={wallet.configured ? 1 : 0} />}
      {/*
        null means "not read yet", which is not the same as "you have no
        wallet". Rendering the setup card while the first fetch is in flight
        told everyone with a funded wallet, on every page load, that it was
        gone. Show nothing until we know.
      */}
      {wallet === null ? null : !wallet.configured ? (
        <div className="card">
          <h2>Set up your trading wallet</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            A wallet this app controls, so it can sell without asking you first. The key is
            encrypted on this machine with your passphrase. Nothing is custodial to anyone
            but you.
          </p>
          <WalletSetup busy={busy === "wallet"} onSubmit={createWallet} />
          <p className="muted small" style={{ marginBottom: 0 }}>
            If this errors about <span className="mono">KEYSTORE_PASSPHRASE</span>, run{" "}
            <span className="mono">npm run setup</span> once and restart.
          </p>
        </div>
      ) : !funded ? (
        <div className="card">
          <h2>Add funds</h2>
          {wallet.balanceError ? (
            <p className="neg small" style={{ marginTop: 0 }}>
              Could not read your balance ({wallet.balanceError}). The wallet is fine — this
              is the RPC, not your funds.
            </p>
          ) : (
            <p className="muted small" style={{ marginTop: 0 }}>
              Send ETH on <strong>Robinhood Chain</strong> to your bot wallet. A little goes a
              long way — 0.02 ETH is plenty to test.
            </p>
          )}
          <AddressBox address={wallet.address!} flash={flash} />
        </div>
      ) : (
        <div className="card" style={{ padding: "14px 18px" }}>
          <div className="spread">
            <div className="row" style={{ gap: 8 }}>
              <strong>{fmtEth(wallet.eth ?? "0", 4)} ETH</strong>
              <a
                className="mono small muted"
                href={`${EXPLORER}/address/${wallet.address}`}
                target="_blank"
                rel="noreferrer"
              >
                {shortAddr(wallet.address ?? "")} ↗
              </a>
            </div>
            <span className="muted small">
              engine {engine?.status.running ? "running" : "off"}
              {engine?.status.transport === "websocket" ? " · ws" : ""}
              {engine?.status.running && typeof engine.status.rpcLagMs === "number"
                ? ` · reacts in ~${engine.status.rpcLagMs < 1000
                    ? `${engine.status.rpcLagMs}ms`
                    : `${(engine.status.rpcLagMs / 1000).toFixed(1)}s`}`
                : ""}
              {engine?.status.watching ? ` · watching ${engine.status.watching}` : ""}
              {engine?.status.lastError ? " · error (see log)" : ""}
            </span>
          </div>
        </div>
      )}

      {/* ── buy ────────────────────────────────────────────────────── */}
      <BuyCard funded={!!funded} live={live} flash={flash} onDone={refresh} picked={picked} />

      {/* ── sniper ─────────────────────────────────────────────────── */}
      <SniperCard funded={!!funded} flash={flash} />

      <LaunchComposer flash={flash} />

      {/* ── open positions ─────────────────────────────────────────── */}
      <div className="card">
        <h2>Open positions {open.length > 0 && <span className="muted">· {open.length}</span>}</h2>
        {open.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            None yet. Buy a token above and it shows up here with live profit/loss.
          </p>
        ) : (
          <div className="plist">
            {open.map((p) => (
              <PositionCard key={p.id} p={p} busy={busy === p.id} onAct={act} />
            ))}
          </div>
        )}
      </div>

      {/* ── history ────────────────────────────────────────────────── */}
      {history.length > 0 && (
        <div className="card">
          <details className="log">
            <summary>History · {history.length}</summary>
            <div className="plist" style={{ marginTop: 10 }}>
              {history.map((p) => (
                <PositionCard key={p.id} p={p} busy={false} onAct={act} done />
              ))}
            </div>
          </details>
        </div>
      )}

      {/* ── activity log ───────────────────────────────────────────── */}
      <div className="card">
        <details className="log">
          <summary>
            Activity log{engine?.status.lastError ? " · has errors" : ""}
          </summary>
          <div className="logbody">
            {(engine?.recentLog ?? []).length === 0 ? (
              <span className="muted">Quiet so far.</span>
            ) : (
              engine!.recentLog.map((l, i) => (
                <div
                  key={i}
                  className={l.level === "error" ? "neg" : l.level === "warn" ? "" : "muted"}
                  style={{ color: l.level === "warn" ? "var(--amber)" : undefined }}
                >
                  {new Date(l.ts).toLocaleTimeString()} {l.message}
                </div>
              ))
            )}
          </div>
        </details>
      </div>
        </div>
      </div>
      )}

      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
function AddressBox({
  address,
  flash,
}: {
  address: string;
  flash: (k: "ok" | "err", m: string) => void;
}) {
  return (
    <div className="row" style={{ gap: 8 }}>
      <code
        className="mono"
        style={{
          background: "var(--bg)",
          border: "1px solid var(--line-2)",
          borderRadius: 10,
          padding: "10px 12px",
          fontSize: 13,
          flex: 1,
          minWidth: 240,
          overflowWrap: "anywhere",
        }}
      >
        {address}
      </code>
      <button
        className="btn btn-sm"
        onClick={() => {
          navigator.clipboard?.writeText(address).then(
            () => flash("ok", "Address copied."),
            () => flash("err", "Copy failed — select it manually."),
          );
        }}
      >
        Copy
      </button>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
function BuyCard({
  funded,
  live,
  flash,
  onDone,
  picked,
}: {
  funded: boolean;
  live: boolean;
  flash: (k: "ok" | "err", m: string) => void;
  onDone: () => void;
  picked: { address: string; n: number } | null;
}) {
  const [addr, setAddr] = useState("");
  const [snap, setSnap] = useState<TokenSnap | null>(null);
  const [looking, setLooking] = useState(false);
  const [eth, setEth] = useState("0.01");
  const [mode, setMode] = useState<Mode>("balanced");
  const [tp, setTp] = useState("50");
  const [sl, setSl] = useState("25");
  const [trail, setTrail] = useState("");
  const [slip, setSlip] = useState("8");
  const [gradExit, setGradExit] = useState("92");
  const [buying, setBuying] = useState(false);
  const last = useRef("");
  const lookupRef = useRef<() => void>(() => {});
  /** The card itself, so picking a coin can bring it to you. */
  const cardRef = useRef<HTMLDivElement>(null);
  /** The amount field, so the only thing left to do is say how much. */
  const ethRef = useRef<HTMLInputElement>(null);
  const [arrived, setArrived] = useState(false);
  /** Set when a pick is in flight, so the focus can wait for the lookup. */
  const wantFocus = useRef(false);

  const targets = useMemo(() => {
    if (mode === "custom") {
      return {
        tp: tp.trim() ? Number(tp) : null,
        sl: sl.trim() ? Number(sl) : null,
        trail: trail.trim() ? Number(trail) : null,
      };
    }
    return { tp: PRESETS[mode].tp, sl: PRESETS[mode].sl, trail: null };
  }, [mode, tp, sl, trail]);

  const lookup = useCallback(async () => {
    const a = addr.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(a)) {
      flash("err", "That doesn't look like a token address (0x…40 hex chars).");
      return;
    }
    setLooking(true);
    setSnap(null);
    last.current = a;
    try {
      const r = await fetch(`/api/token?address=${a}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "lookup failed");
      if (last.current === a) setSnap(j);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "lookup failed");
    } finally {
      setLooking(false);
    }
  }, [addr, flash]);
  lookupRef.current = lookup;

  /*
   * Picking from the feed fills the box, looks the coin up, brings this card
   * to the top of the screen and puts the cursor in the amount field.
   *
   * Filling the box was already happening and was not enough: the panel is
   * long, so on a scrolled page the thing that just changed was off-screen and
   * the click looked like it had done nothing. What is left after this is type
   * an amount and press Buy — which is the whole point of a sniper.
   *
   * The cursor deliberately lands on the amount and not on Buy. Focusing the
   * button would make a stray Enter spend money.
   */
  useEffect(() => {
    if (!picked) return;
    setAddr(picked.address);
    setSnap(null);
    setArrived(true);
    wantFocus.current = true;
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    const t = setTimeout(() => lookupRef.current(), 0);
    const cool = setTimeout(() => setArrived(false), 1100);
    return () => {
      clearTimeout(t);
      clearTimeout(cool);
    };
  }, [picked]);

  /*
   * Focus once the coin is actually on screen.
   *
   * The amount field does not exist until the lookup returns and the snapshot
   * renders, so focusing on a timer after the click raced the network and lost
   * — measured landing on nothing. Waiting for `snap` is the real signal.
   */
  useEffect(() => {
    if (!snap || !wantFocus.current) return;
    wantFocus.current = false;
    ethRef.current?.select();
  }, [snap]);

  const submit = async () => {
    if (!snap) return;
    if (targets.tp == null && targets.sl == null && targets.trail == null) {
      flash("err", "Set at least a take-profit or stop-loss.");
      return;
    }
    setBuying(true);
    try {
      const body: Record<string, unknown> = {
        tokenAddress: snap.address,
        ethAmount: eth,
        slippageBps: Math.round(Number(slip) * 100),
        graduationExitPct: gradExit.trim() ? Number(gradExit) : null,
      };
      if (targets.tp != null) body.takeProfitPct = targets.tp;
      if (targets.sl != null) body.stopLossPct = targets.sl;
      if (targets.trail != null) body.trailingStopPct = targets.trail;

      const r = await fetch("/api/positions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "buy failed");
      if (j.dryRun) {
        flash(
          "ok",
          `Dry run OK — entry ~${fmtPrice(j.preview.entryPrice)} ${snap.quoteSymbol}. Flip the switch to trade for real.`,
        );
      } else {
        flash("ok", `Bought ${snap.symbol}. Now watching for your exit.`);
        setSnap(null);
        setAddr("");
      }
      onDone();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "buy failed");
    } finally {
      setBuying(false);
    }
  };

  const g = snap?.graduation;

  return (
    <div className={`card${arrived ? " card-arrived" : ""}`} ref={cardRef}>
      <h2>Buy a token</h2>
      {/*
        Looking up a token reads the chain and costs nothing, so it must work
        with an empty wallet — inspecting a token before deciding to fund one is
        the normal order of events. Only the buy itself needs money.
      */}
      <p className="muted small" style={{ marginTop: 0 }}>
        {funded
          ? "Paste an address to see its price, liquidity and progress to graduation."
          : "Look up any token for free. You'll need funds in the wallet to buy."}
      </p>

      <div className="row" style={{ gap: 8 }}>
        <input
          className="input"
          placeholder="Paste a pons.family token address"
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && lookup()}
          style={{ flex: 1 }}
        />
        <button className="btn" onClick={lookup} disabled={looking}>
          {looking ? "…" : "Look up"}
        </button>
      </div>

      {snap && !snap.tradeable && (
        <p className="neg small" style={{ marginBottom: 0 }}>
          Can&apos;t trade {snap.symbol}: {snap.reason ?? "not tradeable right now"}.
        </p>
      )}

      {snap && snap.tradeable && (
        <div style={{ marginTop: 18 }}>
          <div className="spread">
            <div>
              <strong style={{ fontSize: 16 }}>{snap.name}</strong>{" "}
              <span className="muted">{snap.symbol}</span>
            </div>
            <span className="muted small">
              {fmtPrice(snap.price.priceQuote)} {snap.quoteSymbol} · fee{" "}
              {((snap.feeBps + snap.creatorTaxBps) / 100).toFixed(1)}%
            </span>
          </div>
          {g && !g.graduated && (
            <div style={{ marginTop: 8 }}>
              <span className="muted small">
                {g.progressPct.toFixed(0)}% of the way to graduation (
                {fmtEth(g.currentQuote, 2)} / {fmtEth(g.thresholdQuote, 1)} {snap.quoteSymbol})
              </span>
              <div className="bar">
                <i style={{ width: `${Math.min(100, g.progressPct)}%` }} />
              </div>
            </div>
          )}

          <label className="field" style={{ marginTop: 18 }}>
            <span>Amount to spend (ETH)</span>
            <div className="row" style={{ gap: 8 }}>
              <input
                className="input"
                ref={ethRef}
                value={eth}
                onChange={(e) => setEth(e.target.value)}
                style={{ maxWidth: 140 }}
              />
              {["0.005", "0.01", "0.05"].map((v) => (
                <button key={v} className="btn btn-sm btn-outline" onClick={() => setEth(v)}>
                  {v}
                </button>
              ))}
            </div>
          </label>

          <label className="field">
            <span>Sell automatically when…</span>
            <div className="preset">
              {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((k) => (
                <button
                  key={k}
                  className="btn btn-sm"
                  data-sel={mode === k}
                  onClick={() => setMode(k)}
                >
                  {PRESETS[k].label}
                  <br />
                  <span className="small muted">
                    +{PRESETS[k].tp}% / −{PRESETS[k].sl}%
                  </span>
                </button>
              ))}
              <button
                className="btn btn-sm"
                data-sel={mode === "custom"}
                onClick={() => setMode("custom")}
              >
                Custom
              </button>
            </div>
          </label>

          {mode === "custom" && (
            <div className="row" style={{ gap: 10 }}>
              <label className="field" style={{ flex: 1, minWidth: 110 }}>
                <span>Take profit %</span>
                <input className="input" value={tp} onChange={(e) => setTp(e.target.value)} placeholder="off" />
              </label>
              <label className="field" style={{ flex: 1, minWidth: 110 }}>
                <span>Stop loss %</span>
                <input className="input" value={sl} onChange={(e) => setSl(e.target.value)} placeholder="off" />
              </label>
              <label className="field" style={{ flex: 1, minWidth: 110 }}>
                <span>Trailing %</span>
                <input className="input" value={trail} onChange={(e) => setTrail(e.target.value)} placeholder="off" />
              </label>
            </div>
          )}

          <div className="row" style={{ gap: 10 }}>
            <label className="field" style={{ flex: 1, minWidth: 120 }}>
              <span>Max slippage %</span>
              <input className="input" value={slip} onChange={(e) => setSlip(e.target.value)} />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 160 }}>
              <span>Bail out at % to graduation</span>
              <input
                className="input"
                value={gradExit}
                onChange={(e) => setGradExit(e.target.value)}
                placeholder="off"
              />
            </label>
          </div>
          <p className="muted small" style={{ margin: "-6px 0 12px" }}>
            After graduation the curve stops accepting sells and the token moves to a
            Uniswap v4 pool this app can&apos;t exit yet — so it sells just before.
          </p>

          <button className="btn btn-primary btn-lg" onClick={submit} disabled={buying || (live && !funded)}>
            {buying
              ? "Submitting…"
              : live && !funded
                ? "Add funds to buy"
                : live
                  ? `Buy ${snap.symbol} for ${eth} ETH`
                  : `Preview buy (dry-run)`}
          </button>
          <p className="muted small" style={{ margin: "8px 0 0", textAlign: "center" }}>
            Auto-sells at{" "}
            {targets.tp != null ? `+${targets.tp}%` : "—"} /{" "}
            {targets.sl != null ? `−${targets.sl}%` : "—"}
            {targets.trail != null ? `, or ${targets.trail}% off the peak` : ""}.
          </p>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
function PositionCard({
  p,
  busy,
  onAct,
  done,
}: {
  p: Position;
  busy: boolean;
  onAct: (id: string, kind: "close" | "cancel") => void;
  done?: boolean;
}) {
  const pos = p.pnl_pct >= 0;
  const spent = weiToUnits(p.quote_in_wei, 18);
  const heldTokens = weiToUnits(p.tokens_held_wei, p.token_decimals);
  const valueNow = heldTokens * p.current_price;
  const targetTxt = [
    p.take_profit_pct ? `+${p.take_profit_pct}%` : null,
    p.stop_loss_pct ? `−${p.stop_loss_pct}%` : null,
    p.trailing_stop_pct ? `trail ${p.trailing_stop_pct}%` : null,
    p.graduation_exit_pct ? `grad ${p.graduation_exit_pct}%` : null,
  ]
    .filter(Boolean)
    .join(" / ");

  return (
    <div className="pcard">
      <div className="top">
        <div>
          <a
            href={`${EXPLORER}/token/${p.token_address}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--text)", fontWeight: 650 }}
          >
            {p.token_symbol}
          </a>
          <div className="meta">
            in {fmtEth(spent, 4)} {p.quote_symbol}
            {!done && <> · now ≈ {fmtEth(valueNow, 4)} {p.quote_symbol}</>}
            {" · "}
            {done
              ? `${p.status}${p.close_reason ? ` (${p.close_reason})` : ""}`
              : `auto-sell ${targetTxt || "—"}`}
          </div>
          {p.error && (
            <div className="neg small" style={{ marginTop: 4 }}>
              {p.error}
            </div>
          )}
        </div>
        <div style={{ textAlign: "right" }}>
          <div className={`pnl-big ${pos ? "pos" : "neg"}`}>{fmtPct(p.pnl_pct, 1)}</div>
          {!done && (
            <div className="row" style={{ gap: 6, marginTop: 6, justifyContent: "flex-end" }}>
              <button
                className="btn btn-sm btn-danger"
                disabled={busy || p.status !== "open"}
                onClick={() => onAct(p.id, "close")}
              >
                Sell now
              </button>
              <button
                className="btn btn-sm btn-outline"
                disabled={busy || p.status !== "open"}
                onClick={() => onAct(p.id, "cancel")}
                title="Stop watching — keeps the tokens"
              >
                Stop
              </button>
            </div>
          )}
          {done && p.sell_tx && (
            <a
              className="small"
              href={`${EXPLORER}/tx/${p.sell_tx}`}
              target="_blank"
              rel="noreferrer"
            >
              sell tx ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
interface TickerWatchEntry {
  ticker: string;
  /** null means any maker, which is the risky mode — see TickerWatch below. */
  deployer: string | null;
  ethAmount: string | null;
  maxBuys: number;
  bought: number;
  expiresAt: string | null;
}
interface SniperCfg {
  enabled: boolean;
  ethAmount: string;
  takeProfitPct: number | null;
  stopLossPct: number | null;
  trailingStopPct: number | null;
  graduationExitPct: number | null;
  slippageBps: number;
  delaySeconds: number;
  minLiquidityEth: number | null;
  maxLiquidityEth: number | null;
  maxCreatorTaxBps: number;
  minOtherBuys: number;
  nameAllowRegex: string | null;
  nameDenyRegex: string | null;
  deployerAllow: string[];
  deployerDeny: string[];
  allowNonEthQuotes: boolean;
  tickerWatch: TickerWatchEntry[];
  tickerDelaySeconds: number;
  maxConcurrentSnipes: number;
  maxSnipesPerHour: number;
  maxDailySpendEth: number;
}
interface SniperStatus {
  running: boolean;
  enabled: boolean;
  live: boolean;
  launchesSeen: number;
  sniped: number;
  skipped: number;
  errors: number;
  pending: number;
  spentTodayEth: number;
  snipesLastHour: number;
  openSnipes: number;
  lastError: string | null;
  /** Launches the reconciliation sweep recovered after the watcher missed them. */
  missed?: number;
  /** Set when the WebSocket was abandoned for HTTP polling. */
  wsDemoted?: string | null;
  recent: {
    ts: string;
    token_address: string;
    token_symbol: string | null;
    decision: string;
    reason: string;
    buy_tx: string | null;
  }[];
}

function SniperCard({
  funded,
  flash,
}: {
  funded: boolean;
  flash: (k: "ok" | "err", m: string) => void;
}) {
  const [cfg, setCfg] = useState<SniperCfg | null>(null);
  const [status, setStatus] = useState<SniperStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const dirty = useRef(false);

  const load = useCallback(async () => {
    try {
      const j = await fetch("/api/sniper").then((r) => r.json());
      if (!dirty.current) setCfg(j.config);
      setStatus(j.status);
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 4000);
    return () => clearInterval(iv);
  }, [load]);

  const patch = (p: Partial<SniperCfg>) => {
    dirty.current = true;
    setCfg((c) => (c ? { ...c, ...p } : c));
  };

  const save = async (override?: Partial<SniperCfg>) => {
    if (!cfg) return;
    setSaving(true);
    try {
      const r = await fetch("/api/sniper", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...cfg, ...(override ?? {}) }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "save failed");
      dirty.current = false;
      setCfg(j.config);
      setStatus(j.status);
      flash("ok", "Sniper settings saved.");
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  };

  if (!cfg) return null;
  const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));

  return (
    <div className="card" style={{ opacity: funded ? 1 : 0.55 }}>
      <div className="spread">
        <h2 className="shead">Sniper</h2>
        <div className="row" style={{ gap: 10 }}>
          <span className={cfg.enabled ? "chip chip-live" : "chip chip-off"}>
            <span className="dot" />
            {cfg.enabled ? "ARMED" : "OFF"}
          </span>
          <button
            className="switch"
            data-on={cfg.enabled}
            disabled={saving || !funded}
            onClick={() => {
              const next = !cfg.enabled;
              if (
                next &&
                !confirm(
                  "Arm the sniper? It will automatically BUY new pons launches that pass your filters, using real funds when live trading is on.",
                )
              )
                return;
              patch({ enabled: next });
              save({ enabled: next });
            }}
          />
        </div>
      </div>
      <p className="ssub">Buys brand-new launches for you, by rule, without asking.</p>

      {status && (
        /*
         * Sentences, not a telemetry dump.
         *
         * This line used to read "watching · seen 1563 · sniped 0 · skipped
         * 1563 · today 0.0000 / 0.1 ETH · open 0/3 · DRY-RUN (no real buys)".
         * Every number in it was true and almost none of it was legible: the
         * reader has to know that "sniped" means bought and that "0/3" is
         * positions rather than a score. Same facts, said out loud.
         */
        <p className="muted small" style={{ marginTop: 6 }}>
          {status.running ? "Watching for new coins." : "Not running."} Seen{" "}
          {status.launchesSeen.toLocaleString()}, bought {status.sniped.toLocaleString()}, skipped{" "}
          {status.skipped.toLocaleString()}.
          {status.pending ? ` ${status.pending} being bought now.` : ""} Spent{" "}
          {status.spentTodayEth.toFixed(4)} of {cfg.maxDailySpendEth} ETH today.{" "}
          {status.openSnipes} of {cfg.maxConcurrentSnipes} slots in use.
          {!status.live ? " Practice mode — it is not spending real money." : ""}
          {/* A raw viem error truncated mid-word tells the reader nothing. The
              cases that matter have their own wording; the rest points at the log. */}
          {status.wsDemoted ? " The live connection dropped, so it is checking on a timer." : ""}
          {status.missed ? ` ${status.missed} coins were caught by the backup check.` : ""}
          {status.lastError ? " Something errored — see the log below." : ""}
        </p>
      )}

      <div className="row" style={{ gap: 10, marginTop: 8 }}>
        <label className="field" style={{ flex: 1, minWidth: 110, marginBottom: 0 }}>
          <span>Spend per snipe (ETH)</span>
          <input className="input" value={cfg.ethAmount} onChange={(e) => patch({ ethAmount: e.target.value })} />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 90, marginBottom: 0 }}>
          <span>Take profit %</span>
          <input
            className="input"
            value={cfg.takeProfitPct ?? ""}
            onChange={(e) => patch({ takeProfitPct: num(e.target.value) })}
            placeholder="off"
          />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 90, marginBottom: 0 }}>
          <span>Stop loss %</span>
          <input
            className="input"
            value={cfg.stopLossPct ?? ""}
            onChange={(e) => patch({ stopLossPct: num(e.target.value) })}
            placeholder="off"
          />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 90, marginBottom: 0 }}>
          <span>Buy delay (s)</span>
          <input
            className="input"
            value={cfg.delaySeconds}
            onChange={(e) => patch({ delaySeconds: Number(e.target.value) || 0 })}
          />
        </label>
      </div>

      <TickerWatch cfg={cfg} patch={patch} />

      <button
        className="btn btn-sm btn-outline"
        style={{ marginTop: 12 }}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "Hide filters" : "Filters & limits"}
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          {/*
            Roughly half of every pons launch is priced in something other than
            ETH, so this doubles what the sniper can reach. It is a toggle
            rather than a default because the extra swap costs a pool fee, its
            own gas and its own chance to revert.
          */}
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={!!cfg.allowNonEthQuotes}
              onChange={(e) => patch({ allowNonEthQuotes: e.target.checked })}
            />
            <span>
              <strong>Also buy coins priced in USDG, NVDA and other stocks</strong>
              <em>
                About half of all launches. Your ETH is swapped for the coin&rsquo;s currency
                first, which costs a small pool fee and one extra transaction.
              </em>
            </span>
          </label>

          <div className="row" style={{ gap: 10 }}>
            <label className="field" style={{ flex: 1, minWidth: 120 }}>
              <span>Min liquidity (ETH)</span>
              <input
                className="input"
                value={cfg.minLiquidityEth ?? ""}
                onChange={(e) => patch({ minLiquidityEth: num(e.target.value) })}
                placeholder="none"
              />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 120 }}>
              <span>Max creator tax %</span>
              <input
                className="input"
                value={(cfg.maxCreatorTaxBps / 100).toString()}
                onChange={(e) => patch({ maxCreatorTaxBps: Math.round((Number(e.target.value) || 0) * 100) })}
              />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 120 }}>
              <span>Min other buys</span>
              <input
                className="input"
                value={cfg.minOtherBuys}
                onChange={(e) => patch({ minOtherBuys: Number(e.target.value) || 0 })}
              />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 100 }}>
              <span>Slippage %</span>
              <input
                className="input"
                value={(cfg.slippageBps / 100).toString()}
                onChange={(e) => patch({ slippageBps: Math.round((Number(e.target.value) || 0) * 100) })}
              />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 160 }}>
              <span>Bail out at % to graduation</span>
              <input
                className="input"
                value={cfg.graduationExitPct ?? ""}
                onChange={(e) => patch({ graduationExitPct: num(e.target.value) })}
                placeholder="off"
              />
            </label>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <label className="field" style={{ flex: 1, minWidth: 140 }}>
              <span>Name must match (regex)</span>
              <input
                className="input"
                value={cfg.nameAllowRegex ?? ""}
                onChange={(e) => patch({ nameAllowRegex: e.target.value || null })}
                placeholder="any"
              />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 140 }}>
              <span>Name must NOT match (regex)</span>
              <input
                className="input"
                value={cfg.nameDenyRegex ?? ""}
                onChange={(e) => patch({ nameDenyRegex: e.target.value || null })}
                placeholder="none"
              />
            </label>
          </div>
          <label className="field">
            <span>Blocked deployer addresses (one per line)</span>
            <textarea
              className="input"
              rows={2}
              value={cfg.deployerDeny.join("\n")}
              onChange={(e) =>
                patch({ deployerDeny: e.target.value.split(/\s+/).map((x) => x.trim()).filter(Boolean) })
              }
            />
          </label>
          <div className="row" style={{ gap: 10 }}>
            <label className="field" style={{ flex: 1, minWidth: 110 }}>
              <span>Max open snipes</span>
              <input
                className="input"
                value={cfg.maxConcurrentSnipes}
                onChange={(e) => patch({ maxConcurrentSnipes: Number(e.target.value) || 1 })}
              />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 110 }}>
              <span>Max snipes / hour</span>
              <input
                className="input"
                value={cfg.maxSnipesPerHour}
                onChange={(e) => patch({ maxSnipesPerHour: Number(e.target.value) || 1 })}
              />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 130 }}>
              <span>Max daily spend (ETH)</span>
              <input
                className="input"
                value={cfg.maxDailySpendEth}
                onChange={(e) => patch({ maxDailySpendEth: Number(e.target.value) || 0.01 })}
              />
            </label>
          </div>
        </div>
      )}

      {dirty.current && (
        <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} disabled={saving} onClick={() => save()}>
          {saving ? "Saving…" : "Save settings"}
        </button>
      )}

      {status && status.recent.length > 0 && (
        <details className="log" style={{ marginTop: 14 }}>
          <summary>Recent launches · {status.recent.length}</summary>
          <div className="logbody" style={{ marginTop: 8 }}>
            {status.recent.map((e, i) => (
              <div
                key={i}
                className={
                  e.decision === "bought" ? "pos" : e.decision === "error" ? "neg" : "muted"
                }
              >
                {new Date(e.ts).toLocaleTimeString()}{" "}
                {e.decision === "bought" ? "✓ BOUGHT" : e.decision === "error" ? "✗ ERROR" : "– skip"}{" "}
                {e.token_symbol ?? e.token_address.slice(0, 10)} — {e.reason}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/** Where you are in first-run setup. Disappears once there is money to trade. */
function Steps({ done }: { done: number }) {
  const labels = ["Create a wallet", "Add funds", "Buy a token"];
  return (
    <ol className="steps">
      {labels.map((label, i) => (
        <li
          key={label}
          className="step"
          data-state={i < done ? "done" : i === done ? "now" : "todo"}
        >
          <span className="step-num">{i < done ? "✓" : i + 1}</span>
          <span>{label}</span>
        </li>
      ))}
    </ol>
  );
}


/**
 * Tickers to buy on sight.
 *
 * The warning is not decoration. Anyone can deploy a token with any ticker,
 * and the numbers quoted are from this app's own index over a single
 * three-hour window, so a ticker-only watch really will fire on a squatter
 * before it fires on the launch you are waiting for. Pinning the maker's
 * address is what turns this from a lottery into a tool, and the UI says so at
 * the point where the decision is made rather than in a doc nobody opens.
 */
function TickerWatch({
  cfg,
  patch,
}: {
  cfg: SniperCfg;
  patch: (p: Partial<SniperCfg>) => void;
}) {
  const [ticker, setTicker] = useState("");
  const [dev, setDev] = useState("");
  const list = cfg.tickerWatch ?? [];

  const add = () => {
    const t = ticker.trim();
    if (!t) return;
    const d = dev.trim();
    patch({
      tickerWatch: [
        ...list,
        {
          ticker: t,
          deployer: /^0x[a-fA-F0-9]{40}$/.test(d) ? d : null,
          ethAmount: null,
          maxBuys: 1,
          bought: 0,
          // A watch you set up and forget should not fire next week.
          expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
        },
      ],
    });
    setTicker("");
    setDev("");
  };

  return (
    <div style={{ marginTop: 14 }}>
      <h3 className="shead">Buy a ticker on sight</h3>
      <p className="ssub">
        For when you already know a coin is coming and what it will be called. A match
        skips the waiting and the quality checks — but never the tax check or your
        spend limits.
      </p>

      <div className="row" style={{ gap: 8 }}>
        <input
          className="input"
          placeholder="Ticker, e.g. PONS"
          value={ticker}
          onChange={(e) => setTicker(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          style={{ flex: "0 1 150px", textTransform: "uppercase" }}
        />
        <input
          className="input"
          placeholder="Maker address (strongly advised)"
          value={dev}
          onChange={(e) => setDev(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button className="btn btn-sm" onClick={add} disabled={!ticker.trim()}>
          Add
        </button>
      </div>

      <p className="ssub" style={{ marginLeft: 0 }}>
        Add the maker&rsquo;s address if you know it. Tickers get reused constantly — 27% were
        already taken in three hours of launches — so without one this may well buy a copy
        before the launch you meant.
      </p>

      {list.length > 0 && (
        <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
          {list.map((w, i) => {
            const spent = w.bought >= w.maxBuys;
            const expired = !!w.expiresAt && Date.parse(w.expiresAt) <= Date.now();
            return (
              <div
                key={`${w.ticker}-${i}`}
                className="row"
                style={{ gap: 8, alignItems: "center", opacity: spent || expired ? 0.5 : 1 }}
              >
                <strong style={{ fontSize: 13 }}>{w.ticker.toUpperCase()}</strong>
                {w.deployer ? (
                  <span className="mono small muted" title={w.deployer}>
                    from {w.deployer.slice(0, 6)}…{w.deployer.slice(-4)}
                  </span>
                ) : (
                  <span className="pill pill-cold">any maker</span>
                )}
                <span className="muted small">
                  {spent
                    ? "done"
                    : expired
                      ? "expired"
                      : `${w.bought}/${w.maxBuys} bought · ${
                          w.expiresAt
                            ? `${Math.max(0, Math.round((Date.parse(w.expiresAt) - Date.now()) / 3600_000))}h left`
                            : "no expiry"
                        }`}
                </span>
                <button
                  className="btn btn-sm btn-outline"
                  style={{ marginLeft: "auto" }}
                  onClick={() => patch({ tickerWatch: list.filter((_, j) => j !== i) })}
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
