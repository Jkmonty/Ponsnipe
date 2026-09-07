"use client";

/**
 * Instant buying from the hosted feed.
 *
 * Two wallets, doing two different jobs. The trader's normal wallet (MetaMask,
 * Rabby) funds and empties a trading key that lives in this browser; the
 * trading key does the buying, signing locally with nothing to confirm. That
 * is the whole difference between a two-second popup and a buy that lands
 * while the coin is still four seconds old.
 *
 * The trade-off is stated in the UI rather than buried here, because it is the
 * trader's to accept: a key in a browser is a hot key. This site could serve
 * different JavaScript tomorrow, clearing site data destroys it, and anything
 * that can run script on this page while it is unlocked can spend it. It is
 * for the float you are actively trading, nothing more — which is why the
 * limits below are not optional.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { formatEther, formatUnits, getAddress, parseEther, type Address } from "viem";
import { bondingCurveAbi, erc20Abi } from "@/lib/pons/abis";
import { applySlippage, quoteSell } from "@/lib/pons/pricing";
import { robinhoodChain } from "@/lib/chain";
import { browserPublic, executeBuy, findRoute } from "./browserTrade";
import { useBrowserWallet } from "./useBrowserWallet";
import { REVEAL_TIMEOUT_MS, useTradingKey } from "./useTradingKey";
import { forgetPosition, recordBuy, usePositions, type Holding } from "./usePositions";
import { useAutoSell, WATCH_INTERVAL_MS } from "./useAutoSell";

interface Snap {
  address: string;
  symbol: string;
  decimals: number;
  curve: string;
  pairToken: string;
  quoteSymbol: string;
  quoteDecimals: number;
  quoteIsNative: boolean;
  feeBps: number;
  creatorTaxBps: number;
  reserves: { quoteReserve: string; tokenReserve: string };
  graduation: { progressPct: number };
  tradeable: boolean;
  reason?: string;
}

const EXPLORER = "https://robinhoodchain.blockscout.com";
const PRESETS = ["0.005", "0.01", "0.05", "0.1"];
const LIMITS_KEY = "ponsnipe.limits.v1";
const SPENT_KEY = "ponsnipe.spentToday.v1";

interface Limits {
  perTrade: number;
  perDay: number;
}
const DEFAULT_LIMITS: Limits = { perTrade: 0.05, perDay: 0.25 };

function readLimits(): Limits {
  try {
    const r = localStorage.getItem(LIMITS_KEY);
    return r ? { ...DEFAULT_LIMITS, ...JSON.parse(r) } : DEFAULT_LIMITS;
  } catch {
    return DEFAULT_LIMITS;
  }
}

/** Spend so far today, reset by date so a forgotten cap does not last forever. */
function readSpentToday(): number {
  try {
    const r = JSON.parse(localStorage.getItem(SPENT_KEY) ?? "{}") as { d?: string; v?: number };
    return r.d === new Date().toISOString().slice(0, 10) ? (r.v ?? 0) : 0;
  } catch {
    return 0;
  }
}
function addSpentToday(eth: number): void {
  try {
    localStorage.setItem(
      SPENT_KEY,
      JSON.stringify({ d: new Date().toISOString().slice(0, 10), v: readSpentToday() + eth }),
    );
  } catch {
    /* private mode; the cap simply does not persist */
  }
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function TradePanel({
  picked,
  onPickHolding,
}: {
  picked: { address: string; n: number } | null;
  /** Load one of the trader's own holdings into the panel above. */
  onPickHolding?: (token: string) => void;
}) {
  const ext = useBrowserWallet();
  const key = useTradingKey();

  const [snap, setSnap] = useState<Snap | null>(null);
  const [eth, setEth] = useState("0.01");
  const [slipPct, setSlipPct] = useState("8");
  const [pass, setPass] = useState("");
  const [importPk, setImportPk] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string; tx?: string } | null>(null);
  const [bal, setBal] = useState<bigint | null>(null);
  const [held, setHeld] = useState<bigint | null>(null);
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
  const [spent, setSpent] = useState(0);
  const [routeOk, setRouteOk] = useState<boolean | null>(null);
  const [fundEth, setFundEth] = useState("0.05");
  const [revealed, setRevealed] = useState<string | null>(null);
  /** Set once sellHolding exists, so the watcher declared above can reach it. */
  const sellHoldingRef = useRef<((h: {
    address: string;
    curve: string;
    symbol: string;
    decimals: number;
    balance: bigint;
  }) => Promise<`0x${string}` | undefined>) | null>(null);
  /** Bumped after any trade, so holdings re-read rather than going stale. */
  const [moved, setMoved] = useState(0);
  const [autoTick, setAutoTick] = useState(0);
  const { holdings, reload: reloadPositions } = usePositions(key.address, moved + autoTick);

  const auto = useAutoSell(
    key.address,
    key.unlocked,
    holdings,
    useCallback(
      async (h: Holding) => {
        await sellHoldingRef.current?.({
          address: h.token,
          curve: h.curve,
          symbol: h.symbol,
          decimals: h.decimals,
          balance: h.balance,
        });
      },
      [],
    ),
  );
  useEffect(() => setAutoTick(auto.tick), [auto.tick]);
  // Armed rules keep the wallet awake; disarming lets it idle out again.
  useEffect(() => key.setWatching(auto.armed > 0), [auto.armed, key]);

  /*
   * Take the key back off the screen on its own.
   *
   * It was shown until someone remembered to press hide, which on a shared
   * machine means it can sit in the DOM indefinitely after being copied.
   */
  useEffect(() => {
    if (!revealed) return;
    const t = setTimeout(() => setRevealed(null), REVEAL_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [revealed]);

  useEffect(() => {
    setLimits(readLimits());
    setSpent(readSpentToday());
  }, []);

  /** Load whichever coin the feed handed over. */
  useEffect(() => {
    if (!picked) return;
    setSnap(null);
    setMsg(null);
    setRouteOk(null);
    void (async () => {
      try {
        const r = await fetch(`/api/token?address=${picked.address}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "lookup failed");
        setSnap(j);
        // A coin priced in something else needs a pool to swap into. Check now,
        // so the button can say so before money moves rather than after.
        if (!j.quoteIsNative) setRouteOk(!!(await findRoute(getAddress(j.pairToken))));
      } catch (e) {
        setMsg({ kind: "err", text: e instanceof Error ? e.message : "lookup failed" });
      }
    })();
  }, [picked]);

  const refresh = useCallback(async () => {
    const c = browserPublic();
    if (key.address) {
      try {
        setBal(await c.getBalance({ address: key.address }));
      } catch {
        setBal(null);
      }
    }
    if (key.address && snap) {
      try {
        setHeld(
          (await c.readContract({
            address: getAddress(snap.address),
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [key.address],
          })) as bigint,
        );
      } catch {
        setHeld(null);
      }
    } else setHeld(null);
  }, [key.address, snap]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const slippageBps = Math.round((Number(slipPct) || 0) * 100);
  const amount = Number(eth) || 0;
  const overPerTrade = amount > limits.perTrade;
  const overDaily = spent + amount > limits.perDay;

  const buy = async () => {
    if (!snap || !key.client || !key.address) return;
    if (overPerTrade || overDaily) return;
    setBusy("buy");
    setMsg(null);
    try {
      const ethIn = parseEther(eth);
      const { hashes, spentQuote } = await executeBuy(key.client, key.address, ethIn, {
        curve: getAddress(snap.curve),
        token: getAddress(snap.address),
        pairToken: snap.pairToken as Address,
        quoteIsNative: snap.quoteIsNative,
        reserves: {
          quoteReserve: BigInt(snap.reserves.quoteReserve),
          tokenReserve: BigInt(snap.reserves.tokenReserve),
        },
        feeBps: snap.feeBps,
        creatorTaxBps: snap.creatorTaxBps,
        slippageBps,
      });
      key.touch();
      recordBuy(key.address, {
        token: snap.address,
        curve: snap.curve,
        symbol: snap.symbol,
        decimals: snap.decimals,
        quoteSymbol: snap.quoteSymbol,
        quoteDecimals: snap.quoteDecimals,
        quoteIsNative: snap.quoteIsNative,
        // What reached the curve, which on a zapped buy is the swapped amount
        // rather than the ETH — the two are different assets entirely.
        spentQuote: spentQuote.toString(),
        spentEth: ethIn.toString(),
        at: Date.now(),
      });
      setMoved((n) => n + 1);
      addSpentToday(amount);
      setSpent(readSpentToday());
      setMsg({ kind: "ok", text: `Bought ${snap.symbol}.`, tx: hashes[hashes.length - 1] });
      void refresh();
    } catch (e) {
      setMsg({ kind: "err", text: (e instanceof Error ? e.message : "buy failed").split("\n")[0] });
    } finally {
      setBusy(null);
    }
  };

  /**
   * Sell an entire holding.
   *
   * Used by the button and by the automatic rules alike — one selling path, so
   * an exit a rule takes and one a person takes cannot behave differently.
   */
  const sellHolding = useCallback(
    async (h: {
      address: string;
      curve: string;
      symbol: string;
      decimals: number;
      balance: bigint;
    }) => {
      if (!key.client || !key.address || h.balance <= 0n) return;
      const c = browserPublic();
      const token = getAddress(h.address);
      const curve = getAddress(h.curve);
      const allowance = (await c.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [key.address, curve],
      })) as bigint;
      if (allowance < h.balance) {
        const ap = await key.client.writeContract({
          account: key.account!,
          chain: robinhoodChain,
          address: token,
          abi: erc20Abi,
          functionName: "approve",
          args: [curve, h.balance],
        });
        await c.waitForTransactionReceipt({ hash: ap });
      }
      /*
       * Reserves AND fees read from the curve at sell time.
       *
       * Not carried in from the caller: a holding row does not know the fees,
       * and the first version of this passed 100bps and zero tax as
       * placeholders — which would have computed the minimum-out from invented
       * numbers and either reverted the sale or accepted a worse fill than the
       * trader was shown. Both come from the contract, at the moment of
       * selling, because a rule can fire long after the last repaint.
       */
      const [rv, fee, tax] = await c.multicall({
        contracts: [
          { address: curve, abi: bondingCurveAbi, functionName: "getReserves" as const },
          { address: curve, abi: bondingCurveAbi, functionName: "feeBps" as const },
          { address: curve, abi: bondingCurveAbi, functionName: "creatorTaxBps" as const },
        ],
        allowFailure: true,
      });
      if (rv.status !== "success") throw new Error("could not read the curve to price the sale");
      const [q, t] = rv.result as readonly [bigint, bigint];
      const quote = quoteSell(
        h.balance,
        { quoteReserve: q, tokenReserve: t },
        fee.status === "success" ? (fee.result as bigint) : 100n,
        tax.status === "success" ? (tax.result as bigint) : 0n,
      );
      const hash = await key.client.writeContract({
        account: key.account!,
        chain: robinhoodChain,
        address: curve,
        abi: bondingCurveAbi,
        functionName: "sell",
        args: [h.balance, applySlippage(quote.quoteOut, slippageBps), key.address],
      });
      await c.waitForTransactionReceipt({ hash });
      key.touch();
      forgetPosition(key.address, h.address);
      setMoved((n) => n + 1);
      return hash;
    },
    [key, slippageBps],
  );

  sellHoldingRef.current = sellHolding;

  const sell = async () => {
    if (!snap || !key.client || !key.address || !held || held <= 0n) return;
    setBusy("sell");
    setMsg(null);
    try {
      const c = browserPublic();
      const token = getAddress(snap.address);
      const curve = getAddress(snap.curve);
      const allowance = (await c.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [key.address, curve],
      })) as bigint;
      if (allowance < held) {
        const ap = await key.client.writeContract({
          account: key.account!,
          chain: robinhoodChain,
          address: token,
          abi: erc20Abi,
          functionName: "approve",
          args: [curve, held],
        });
        await c.waitForTransactionReceipt({ hash: ap });
      }
      const q = quoteSell(
        held,
        {
          quoteReserve: BigInt(snap.reserves.quoteReserve),
          tokenReserve: BigInt(snap.reserves.tokenReserve),
        },
        BigInt(snap.feeBps),
        BigInt(snap.creatorTaxBps),
      );
      const hash = await key.client.writeContract({
        account: key.account!,
        chain: robinhoodChain,
        address: curve,
        abi: bondingCurveAbi,
        functionName: "sell",
        args: [held, applySlippage(q.quoteOut, slippageBps), key.address],
      });
      await c.waitForTransactionReceipt({ hash });
      key.touch();
      setMsg({ kind: "ok", text: `Sold ${snap.symbol}.`, tx: hash });
      if (key.address) forgetPosition(key.address, snap.address);
      setMoved((n) => n + 1);
      void refresh();
    } catch (e) {
      setMsg({ kind: "err", text: (e instanceof Error ? e.message : "sell failed").split("\n")[0] });
    } finally {
      setBusy(null);
    }
  };

  /** Move ETH from the trader's real wallet into the trading key. */
  const fund = async () => {
    if (!ext.client || !ext.address || !key.address) return;
    setBusy("fund");
    setMsg(null);
    try {
      const hash = await ext.client.sendTransaction({
        account: ext.address,
        chain: null,
        to: key.address,
        value: parseEther(fundEth),
      });
      setMsg({ kind: "ok", text: "Funding sent.", tx: hash });
      await browserPublic().waitForTransactionReceipt({ hash });
      setMsg({ kind: "ok", text: `Funded with ${fundEth} ETH.`, tx: hash });
      void refresh();
    } catch (e) {
      const m = e instanceof Error ? e.message : "funding failed";
      setMsg(/rejected|denied|4001/i.test(m) ? null : { kind: "err", text: m.split("\n")[0] });
    } finally {
      setBusy(null);
    }
  };

  /** Send everything back, less a little for the gas of doing so. */
  const withdraw = async () => {
    if (!key.client || !key.address || !ext.address || !bal) return;
    setBusy("withdraw");
    setMsg(null);
    try {
      const c = browserPublic();
      const gas = 21_000n;
      const price = await c.getGasPrice();
      const fee = gas * price * 2n;
      if (bal <= fee) throw new Error("balance is too small to cover the transfer fee");
      const hash = await key.client.sendTransaction({
        account: key.account!,
        chain: robinhoodChain,
        to: ext.address,
        value: bal - fee,
      });
      await c.waitForTransactionReceipt({ hash });
      setMsg({ kind: "ok", text: "Sent back to your wallet.", tx: hash });
      void refresh();
    } catch (e) {
      setMsg({ kind: "err", text: (e instanceof Error ? e.message : "withdraw failed").split("\n")[0] });
    } finally {
      setBusy(null);
    }
  };

  // ── no trading key yet ──────────────────────────────────────────────────
  if (!key.exists) {
    return (
      <aside className="card">
        <h2 className="shead">Instant buys</h2>
        <p className="ssub">
          A trading wallet that lives in this browser, so a buy is one click with nothing to
          confirm. Your normal wallet fills it and empties it; it does the buying.
        </p>
        {/*
          One calm line, with the detail behind a summary.

          It used to be a block of amber, which reads as a hazard sign and gets
          skipped. This says the same thing in the register of a product note,
          and anyone who wants the specifics can open them. What it does not do
          is disappear: it is the only place a stranger is told their money can
          be lost here in a way it could not be in MetaMask, and that sentence
          is what makes putting funds in an informed choice rather than a
          surprise.
        */}
        <p className="ssub" style={{ marginLeft: 0 }}>
          Your key stays in this browser, encrypted with your passphrase. Like any hot wallet,
          keep only what you are actively trading — you can send it back to your own wallet
          whenever you like.
        </p>
        <details className="fineprint">
          <summary>How it works, and what to watch</summary>
          <p>
            The key is generated here and encrypted with your passphrase before being saved.
            It never leaves your browser and this site never receives it. It relocks after
            fifteen minutes without a trade, and there are per-trade and daily spend limits
            you can set below.
          </p>
          <p>
            Two things to know. Clearing this site&rsquo;s data deletes the key, so back it up if
            the balance matters. And while it is unlocked, anything able to run script on this
            page could spend it — which is why it is for a trading float rather than savings.
            For take-profit and stop-loss that survive closing the tab, run your own copy.
          </p>
        </details>
        <label className="field">
          <span>Passphrase (12+ characters)</span>
          <input
            className="input"
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void key.create(pass)}
          />
        </label>
        {showImport && (
          <label className="field">
            <span>Private key to import</span>
            <input className="input" value={importPk} onChange={(e) => setImportPk(e.target.value)} />
          </label>
        )}
        <div className="row" style={{ gap: 8 }}>
          <button
            className="btn btn-primary"
            disabled={key.busy || pass.length < 8}
            onClick={() => void (showImport ? key.importKey(importPk, pass) : key.create(pass))}
          >
            {key.busy ? "…" : showImport ? "Import wallet" : "Create trading wallet"}
          </button>
          <button className="btn btn-sm btn-outline" onClick={() => setShowImport((v) => !v)}>
            {showImport ? "or create new" : "or import a key"}
          </button>
        </div>
        {key.error && <p className="neg small">{key.error}</p>}
      </aside>
    );
  }

  // ── locked ──────────────────────────────────────────────────────────────
  if (!key.unlocked) {
    return (
      <aside className="card">
        <h2 className="shead">Unlock trading wallet</h2>
        <p className="ssub mono" style={{ marginLeft: 13 }}>
          {key.address ? short(key.address) : ""}
        </p>
        <label className="field">
          <span>Passphrase</span>
          <input
            className="input"
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void key.unlock(pass)}
          />
        </label>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-primary" disabled={key.busy} onClick={() => void key.unlock(pass)}>
            {key.busy ? "…" : "Unlock"}
          </button>
          <button
            className="btn btn-sm btn-outline"
            onClick={() => {
              if (confirm("Delete this trading wallet from the browser? Any funds still in it are lost unless you have the key backed up.")) key.forget();
            }}
          >
            Forget it
          </button>
        </div>
        {key.error && <p className="neg small">{key.error}</p>}
      </aside>
    );
  }

  // ── unlocked and trading ────────────────────────────────────────────────
  const canBuy =
    !!snap &&
    snap.tradeable &&
    (snap.quoteIsNative || routeOk === true) &&
    !overPerTrade &&
    !overDaily &&
    busy === null;

  return (
    <aside className="card">
      <div className="spread" style={{ alignItems: "center" }}>
        <h2 className="shead" style={{ margin: 0 }}>
          Trade
        </h2>
        <span
          className="muted small mono"
          title={
            key.lockingIn != null
              ? `Locks after 15 minutes without a trade — about ${Math.ceil(key.lockingIn / 60_000)} min left`
              : (key.address ?? "")
          }
        >
          {key.address ? short(key.address) : ""} ·{" "}
          {bal != null ? `${Number(formatEther(bal)).toFixed(4)} ETH` : "…"}
          {key.lockingIn != null && key.lockingIn < 5 * 60_000
            ? ` · locks in ${Math.ceil(key.lockingIn / 60_000)}m`
            : ""}
        </span>
      </div>

      {bal != null && bal === 0n && (
        <p className="note-warn">
          <strong>Empty.</strong> Send ETH to this wallet to trade with it — from your own
          wallet below, or any exchange.
        </p>
      )}

      {!snap ? (
        <p className="ssub" style={{ marginTop: 8 }}>
          Pick a coin from the feed to buy it.
        </p>
      ) : !snap.tradeable ? (
        <p className="note-warn">
          <strong>{snap.symbol} cannot be traded.</strong> {snap.reason ?? "The curve is closed."}
        </p>
      ) : (
        <>
          <div className="spread" style={{ marginTop: 10 }}>
            <strong>{snap.symbol}</strong>
            <span className="muted small">
              {snap.quoteIsNative ? "ETH" : `via ${snap.quoteSymbol}`} ·{" "}
              {snap.graduation.progressPct.toFixed(1)}%
            </span>
          </div>

          {!snap.quoteIsNative && routeOk === false && (
            <p className="note-warn">
              <strong>No route.</strong> This coin is priced in {snap.quoteSymbol} and there is no
              pool to swap ETH into it.
            </p>
          )}

          <label className="field" style={{ marginTop: 10 }}>
            <span>Spend (ETH)</span>
            <div className="row" style={{ gap: 8 }}>
              <input className="input" value={eth} onChange={(e) => setEth(e.target.value)} style={{ maxWidth: 120 }} />
              {PRESETS.map((v) => (
                <button key={v} className="btn btn-sm btn-outline" onClick={() => setEth(v)}>
                  {v}
                </button>
              ))}
            </div>
          </label>

          {overPerTrade && (
            <p className="neg small">Above your {limits.perTrade} ETH per-trade limit.</p>
          )}
          {!overPerTrade && overDaily && (
            <p className="neg small">
              Would pass your {limits.perDay} ETH daily limit ({spent.toFixed(3)} spent today).
            </p>
          )}

          <button className="btn btn-primary btn-lg" onClick={() => void buy()} disabled={!canBuy}>
            {busy === "buy"
              ? snap.quoteIsNative
                ? "Buying…"
                : `Swapping into ${snap.quoteSymbol}…`
              : `Buy ${snap.symbol}`}
          </button>
          {!snap.quoteIsNative && (
            <p className="muted small" style={{ marginTop: 4 }}>
              Your ETH is swapped into {snap.quoteSymbol} first, then spent on the curve. Two or
              three transactions, all signed here — nothing to confirm.
            </p>
          )}

          {held != null && held > 0n && (
            <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
              <div className="spread">
                <span className="muted small">You hold</span>
                <strong className="small">
                  {Number(formatUnits(held, snap.decimals)).toLocaleString(undefined, {
                    maximumFractionDigits: 0,
                  })}{" "}
                  {snap.symbol}
                </strong>
              </div>
              <button className="btn btn-lg" onClick={() => void sell()} disabled={busy !== null} style={{ marginTop: 6 }}>
                {busy === "sell" ? "Selling…" : `Sell all ${snap.symbol}`}
              </button>
            </div>
          )}
        </>
      )}

      {msg && (
        <p className={msg.kind === "ok" ? "pos small" : "neg small"}>
          {msg.text}{" "}
          {msg.tx && (
            <a href={`${EXPLORER}/tx/${msg.tx}`} target="_blank" rel="noopener noreferrer">
              view ↗
            </a>
          )}
        </p>
      )}

      {/* ── everything held, not just the coin last clicked ── */}
      {holdings.length > 0 && (
        <div className="holdings">
          <div className="spread" style={{ alignItems: "baseline" }}>
            <span className="muted small">
              Holding {holdings.length} coin{holdings.length === 1 ? "" : "s"}
            </span>
            <button className="linkish" onClick={() => void reloadPositions()}>
              refresh
            </button>
          </div>
          {holdings.map((h) => {
            const rule = auto.rules[h.token.toLowerCase()];
            const isArmed = !!rule && (rule.tp != null || rule.sl != null);
            return (
              <div key={h.token} className={`holding-wrap${isArmed ? " armed" : ""}`}>
                <button
                  type="button"
                  className="holding"
                  /* Selecting it loads it above, which is where selling happens —
                     rather than duplicating a sell button on every row. */
                  onClick={() => onPickHolding?.(h.token)}
                  title={`Bought for ${h.spentQuoteNum.toPrecision(4)} ${h.quoteSymbol}`}
                >
                  <span className="holding-sym">{h.symbol}</span>
                  <span className="holding-val num">
                    {h.valueQuote > 0 ? h.valueQuote.toPrecision(4) : "—"}{" "}
                    <i>{h.quoteSymbol}</i>
                  </span>
                  <span
                    className={`holding-pnl num ${
                      h.pnlPct == null ? "muted" : h.pnlPct >= 0 ? "pos" : "neg"
                    }`}
                  >
                    {h.pnlPct == null
                      ? "—"
                      : `${h.pnlPct >= 0 ? "+" : ""}${h.pnlPct.toFixed(1)}%`}
                  </span>
                </button>

                {/* Sell-me-at rules. Only offered where there is a cost basis
                    to measure against — without one there is no percentage. */}
                {h.pnlPct == null ? (
                  <p className="holding-rule muted">No purchase price recorded, so no rule.</p>
                ) : (
                  <div className="holding-rule">
                    <label>
                      <span>take profit</span>
                      <input
                        className="input"
                        inputMode="decimal"
                        placeholder="+%"
                        defaultValue={rule?.tp ?? ""}
                        onBlur={(e) =>
                          auto.save(h.token, {
                            tp: e.target.value.trim() ? Math.abs(Number(e.target.value)) : null,
                            sl: rule?.sl ?? null,
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>stop loss</span>
                      <input
                        className="input"
                        inputMode="decimal"
                        placeholder="-%"
                        defaultValue={rule?.sl ?? ""}
                        onBlur={(e) =>
                          auto.save(h.token, {
                            tp: rule?.tp ?? null,
                            sl: e.target.value.trim() ? Math.abs(Number(e.target.value)) : null,
                          })
                        }
                      />
                    </label>
                    {isArmed && (
                      <button className="linkish" onClick={() => auto.save(h.token, null)}>
                        clear
                      </button>
                    )}
                  </div>
                )}
                {auto.firing === h.token && (
                  <p className="holding-rule pos">Selling now…</p>
                )}
              </div>
            );
          })}

          {auto.armed > 0 && (
            <p className="muted small" style={{ marginTop: 6 }}>
              Watching {auto.armed} position{auto.armed === 1 ? "" : "s"}, checking every{" "}
              {Math.round(WATCH_INTERVAL_MS / 1000)}s.{" "}
              <strong>Only while this tab is open</strong> — close it and nothing sells. For
              exits that survive closing the tab, run your own copy.
            </p>
          )}
          {auto.lastFired && (
            <p className="pos small" style={{ marginTop: 4 }}>
              Sold {auto.lastFired.symbol} — {auto.lastFired.reason}.
            </p>
          )}
        </div>
      )}

      {/* ── funding, limits and getting out ── */}
      <details style={{ marginTop: 14 }}>
        <summary className="muted small" style={{ cursor: "pointer" }}>
          Funds, limits and backup
        </summary>

        <div style={{ marginTop: 10 }}>
          {ext.address ? (
            <>
              <label className="field">
                <span>Add from {short(ext.address)} (ETH)</span>
                <div className="row" style={{ gap: 8 }}>
                  <input className="input" value={fundEth} onChange={(e) => setFundEth(e.target.value)} style={{ maxWidth: 110 }} />
                  <button className="btn btn-sm" onClick={() => void fund()} disabled={busy !== null}>
                    {busy === "fund" ? "Confirm in wallet…" : "Send"}
                  </button>
                </div>
              </label>
              <button className="btn btn-sm btn-outline" onClick={() => void withdraw()} disabled={busy !== null || !bal}>
                {busy === "withdraw" ? "Sending…" : "Send everything back"}
              </button>
            </>
          ) : (
            <button className="btn btn-sm" onClick={() => void ext.connect()}>
              Connect your wallet to add or remove funds
            </button>
          )}

          <div className="row" style={{ gap: 10, marginTop: 12 }}>
            <label className="field" style={{ flex: 1, minWidth: 110, marginBottom: 0 }}>
              <span>Max per trade</span>
              <input
                className="input"
                value={limits.perTrade}
                onChange={(e) => {
                  const l = { ...limits, perTrade: Number(e.target.value) || 0 };
                  setLimits(l);
                  localStorage.setItem(LIMITS_KEY, JSON.stringify(l));
                }}
              />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 110, marginBottom: 0 }}>
              <span>Max per day</span>
              <input
                className="input"
                value={limits.perDay}
                onChange={(e) => {
                  const l = { ...limits, perDay: Number(e.target.value) || 0 };
                  setLimits(l);
                  localStorage.setItem(LIMITS_KEY, JSON.stringify(l));
                }}
              />
            </label>
          </div>
          <p className="muted small">Spent today: {spent.toFixed(4)} ETH.</p>

          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button
              className="btn btn-sm btn-outline"
              onClick={() => {
                const p = prompt("Passphrase, to show the private key:");
                if (p) void key.reveal(p).then(setRevealed);
              }}
            >
              Back up key
            </button>
            <button className="btn btn-sm btn-outline" onClick={key.lock}>
              Lock
            </button>
          </div>
          {revealed && (
            <p className="note-warn mono" style={{ wordBreak: "break-all" }}>
              {revealed}
              <br />
              <button className="linkish" onClick={() => setRevealed(null)}>
                hide
              </button>
            </p>
          )}
          <p className="muted small" style={{ marginBottom: 0, marginTop: 10 }}>
            Take-profit and stop-loss still need the version you run yourself — a page cannot
            sell for you once it is closed.
          </p>
        </div>
      </details>
    </aside>
  );
}
