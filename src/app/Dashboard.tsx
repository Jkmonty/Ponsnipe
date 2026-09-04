"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtEth, fmtPct, fmtPrice, shortAddr, weiToUnits, EXPLORER } from "@/lib/format";

interface WalletInfo {
  configured: boolean;
  address?: string;
  eth?: string;
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

export default function Dashboard() {
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const flash = useCallback((kind: "ok" | "err", msg: string) => {
    setToast({ kind, msg });
    setTimeout(() => setToast(null), 7000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [w, e, p] = await Promise.all([
        fetch("/api/wallet").then((r) => r.json()),
        fetch("/api/engine").then((r) => r.json()),
        fetch("/api/positions").then((r) => r.json()),
      ]);
      setWallet(w);
      setEngine(e);
      setPositions(p.positions ?? []);
    } catch {
      /* transient */
    }
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

  const createWallet = async () => {
    setBusy("wallet");
    try {
      const r = await post("/api/wallet/create");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "could not create wallet");
      flash("ok", `Wallet created: ${j.address}`);
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
      <div className="spread" style={{ marginBottom: 20 }}>
        <div>
          <h1>pons autotrade</h1>
          <p className="sub">Buy a token, set your exit, walk away.</p>
        </div>
        <div className="row" style={{ gap: 10 }}>
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
        </div>
      </div>

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

      {/* ── setup / wallet ─────────────────────────────────────────── */}
      {!wallet?.configured ? (
        <div className="card">
          <h2>Step 1 — Create your trading wallet</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            A fresh wallet the app controls. Its key is encrypted on this machine. You fund
            it, it does the buying and selling. Nothing is custodial to anyone but you.
          </p>
          <button className="btn btn-primary" disabled={busy === "wallet"} onClick={createWallet}>
            {busy === "wallet" ? "Creating…" : "Create wallet"}
          </button>
          <p className="muted small" style={{ marginBottom: 0 }}>
            If this errors about <span className="mono">KEYSTORE_PASSPHRASE</span>, run{" "}
            <span className="mono">npm run setup</span> once and restart.
          </p>
        </div>
      ) : !funded ? (
        <div className="card">
          <h2>Step 2 — Add funds</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            Send ETH on <strong>Robinhood Chain</strong> to your bot wallet. A little goes a
            long way — 0.02 ETH is plenty to test.
          </p>
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
      <BuyCard funded={!!funded} live={live} flash={flash} onDone={refresh} />

      {/* ── sniper ─────────────────────────────────────────────────── */}
      <SniperCard funded={!!funded} flash={flash} />
      <LaunchFeed />

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
}: {
  funded: boolean;
  live: boolean;
  flash: (k: "ok" | "err", m: string) => void;
  onDone: () => void;
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
    <div className="card" style={{ opacity: funded ? 1 : 0.55 }}>
      <h2>Buy a token</h2>
      {!funded && (
        <p className="muted small" style={{ marginTop: 0 }}>
          Add funds to your wallet first.
        </p>
      )}

      <div className="row" style={{ gap: 8 }}>
        <input
          className="input"
          placeholder="Paste a pons.family token address"
          value={addr}
          disabled={!funded}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && lookup()}
          style={{ flex: 1 }}
        />
        <button className="btn" onClick={lookup} disabled={!funded || looking}>
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

          <button className="btn btn-primary btn-lg" onClick={submit} disabled={buying}>
            {buying
              ? "Submitting…"
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
        <h2 style={{ margin: 0 }}>
          Sniper{" "}
          <span className="muted small" style={{ fontWeight: 400 }}>
            auto‑buy new launches
          </span>
        </h2>
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

      {status && (
        <p className="muted small" style={{ marginTop: 6 }}>
          {status.running ? "watching" : "stopped"} · seen {status.launchesSeen} · sniped{" "}
          {status.sniped} · skipped {status.skipped}
          {status.pending ? ` · ${status.pending} pending` : ""} · today{" "}
          {status.spentTodayEth.toFixed(4)} / {cfg.maxDailySpendEth} ETH · open{" "}
          {status.openSnipes}/{cfg.maxConcurrentSnipes}
          {!status.live ? " · DRY‑RUN (no real buys)" : ""}
          {status.lastError ? ` · error: ${status.lastError.slice(0, 60)}` : ""}
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

      <button
        className="btn btn-sm btn-outline"
        style={{ marginTop: 12 }}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "Hide filters" : "Filters & limits"}
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
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

/** One row of the launch feed, as served by /api/sniper. */
interface LaunchEvent {
  id: number;
  ts: string;
  token_address: string;
  token_symbol: string | null;
  decision: string;
  reason: string;
  quote_symbol: string | null;
  liquidity: number | null;
  other_buys: number | null;
  grad_pct: number | null;
  blocked_by_quote: number | null;
}

function age(ts: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/**
 * Every launch the sniper has looked at, whatever it decided — so you can see
 * at a glance that it is seeing the whole venue and not just the ETH-quoted
 * slice, and which ones it would actually take.
 */
function LaunchFeed() {
  const [events, setEvents] = useState<LaunchEvent[]>([]);
  const [only, setOnly] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    const load = async () => {
      try {
        const j = await fetch("/api/sniper?limit=80").then((r) => r.json());
        if (Array.isArray(j.events)) setEvents(j.events);
      } catch {
        /* transient */
      }
    };
    load();
    const iv = setInterval(load, 3000);
    // Re-render on its own beat so the age column keeps counting up.
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      clearInterval(iv);
      clearInterval(t);
    };
  }, []);

  // "Would buy" covers both a real buy and the two cases that are only blocked
  // by something other than our rules: dry-run, and a quote we cannot zap into.
  const wants = (e: LaunchEvent) =>
    e.decision === "bought" || e.reason.startsWith("DRY-RUN") || e.blocked_by_quote === 1;

  const shown = only ? events.filter(wants) : events;
  const eth = events.filter((e) => e.quote_symbol === "ETH").length;
  const wouldBuy = events.filter(wants).length;

  return (
    <div className="card">
      <div className="spread">
        <h2>Live launches</h2>
        <label className="small muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} />
          only ones it wants
        </label>
      </div>
      <div className="small muted" style={{ marginBottom: 10 }}>
        last {events.length} seen · {eth} ETH-quoted · {events.length - eth} stock/stable-quoted ·{" "}
        <strong className="pos">{wouldBuy} it would take</strong>
      </div>

      {shown.length === 0 && (
        <div className="small muted">
          Nothing yet. The watcher evaluates each launch ~20s after it deploys.
        </div>
      )}

      <div className="feed">
        {shown.map((e) => (
          <div key={e.id} className={`feedrow${wants(e) ? " want" : ""}`}>
            <div className="feedmain">
              <span className="fsym">{e.token_symbol ?? "?"}</span>
              <span className={`qchip q-${(e.quote_symbol ?? "?").toLowerCase()}`}>
                {e.quote_symbol ?? "?"}
              </span>
              <span className="mono small muted">{e.token_address.slice(0, 10)}…</span>
              <span className="small muted">{age(e.ts)}</span>
            </div>
            <div className="feedstats small">
              <span title="liquidity in the curve's own quote token">
                liq {e.liquidity != null ? e.liquidity.toFixed(3) : "–"}
              </span>
              <span title="other wallets that bought before we looked">
                {e.other_buys ?? 0} buyers
              </span>
              <span title="how far toward graduation">
                {e.grad_pct != null ? `${e.grad_pct.toFixed(1)}%` : "–"}
              </span>
            </div>
            <div className={`feedverdict ${e.decision === "bought" ? "pos" : wants(e) ? "warn" : "muted"}`}>
              {e.decision === "bought"
                ? "BOUGHT"
                : e.blocked_by_quote === 1
                  ? `WOULD BUY — needs ${e.quote_symbol} zap`
                  : e.reason.startsWith("DRY-RUN")
                    ? "WOULD BUY (dry-run)"
                    : e.reason}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
