"use client";

/**
 * Buying and selling. Nothing else.
 *
 * This panel used to be the wallet as well: create it, unlock it, fund it, set
 * its limits, back it up — which meant a first-time visitor met a signup form
 * where the trading interface should be. All of that now lives behind the
 * connect button in the header, where a trader already expects to find it, and
 * what is left here is the thing the panel is named after.
 *
 * The two wallets and why they exist are documented in WalletContext; the
 * short version is that the trading key signs locally with nothing to confirm,
 * which is the whole difference between a two-second popup and a buy that
 * lands while the coin is still four seconds old.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, getAddress, parseEther, type Address } from "viem";
import { bondingCurveAbi, erc20Abi } from "@/lib/pons/abis";
import { applySlippage, quoteSell } from "@/lib/pons/pricing";
import { robinhoodChain } from "@/lib/chain";
import { browserPublic, executeBuy, findRoute } from "./browserTrade";
import { useWallet } from "./WalletContext";
import { addSpentToday } from "./limits";
import { forgetPosition, recordBuy, usePositions, type Holding } from "./usePositions";
import { useAutoSell, WATCH_INTERVAL_MS } from "./useAutoSell";
import { CollapseButton, useCollapsed } from "./Collapse";
import Chart from "./Chart";
import { useSniper, WATCH_POLL_MS } from "./useSniper";
import SniperRules from "./SniperRules";

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

/**
 * Slippage tolerance, in percent.
 *
 * Fixed rather than a control, and deliberately loose: a coin seconds old moves
 * between reading its reserves and the transaction landing, and a tight
 * tolerance on a curve this thin reverts the buy — which on a launch costs the
 * whole entry, not a few basis points.
 */
const SLIPPAGE_PCT = 8;

export default function TradePanel({
  picked,
  onPickHolding,
}: {
  picked: { address: string; n: number } | null;
  /** Load one of the trader's own holdings into the panel above. */
  onPickHolding?: (token: string) => void;
}) {
  const { key, bal, refreshBal, limits, spent, syncSpent, openMenu } = useWallet();

  const [snap, setSnap] = useState<Snap | null>(null);
  const [eth, setEth] = useState("0.01");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string; tx?: string } | null>(null);
  const [held, setHeld] = useState<bigint | null>(null);
  const [routeOk, setRouteOk] = useState<boolean | null>(null);
  /** The coin was put down by hand, rather than never having loaded. */
  const [closed, setClosed] = useState(false);
  /* The snipe form. Kept here rather than inside useSniper: a half-typed
     ticker is not a watch, and should not be persisted as one. */
  const [wTicker, setWTicker] = useState("");
  const [wDev, setWDev] = useState("");
  const [wEth, setWEth] = useState("0.01");
  /* Sensible exits pre-filled rather than blank. An unattended buy with no stop
     is the one combination here that can lose everything while nobody is
     looking, so the protected version is what you get by not deciding. */
  const [wTp, setWTp] = useState("50");
  const [wSl, setWSl] = useState("25");
  /* What share of the position the take-profit sells. Under 100 leaves a
     runner behind, which is why the stop-loss stays armed on it. */
  const [wTpPct, setWTpPct] = useState("70");
  /* Open by default — the other sniper sections start folded, but this is the
     one people came for. The control is there so it need not stay open. */
  const snipeFold = useCollapsed("snipe", false);
  /** Set once sellHolding exists, so the watcher declared above can reach it. */
  const sellHoldingRef = useRef<((h: {
    address: string;
    curve: string;
    symbol: string;
    decimals: number;
    /** How many tokens to sell, which may be less than the whole holding. */
    balance: bigint;
    /** Set when something is being left behind, so the record is kept. */
    partial?: boolean;
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
      async (h: Holding, sellPct: number) => {
        await sellHoldingRef.current?.({
          address: h.token,
          curve: h.curve,
          symbol: h.symbol,
          decimals: h.decimals,
          /*
           * The share is worked out here, in BigInt, rather than passed down
           * as a percentage and converted later. Token balances routinely
           * exceed what a double can hold exactly, so a round trip through a
           * float would ask the curve to sell an amount a few units off the
           * one the wallet actually has.
           */
          balance: (h.balance * BigInt(Math.round(sellPct))) / 100n,
          partial: sellPct < 100,
        });
      },
      [],
    ),
  );
  useEffect(() => setAutoTick(auto.tick), [auto.tick]);

  /**
   * Put the picked coin down.
   *
   * `picked` deliberately is not cleared: it carries a timestamp, so clicking
   * the same row again still counts as a new pick and loads it back.
   */
  const closeCoin = useCallback(() => {
    setSnap(null);
    setMsg(null);
    setRouteOk(null);
    // Without this the panel cannot tell "closed" from "still loading", and
    // falls back to the loading bars forever — the skeleton is shown whenever
    // there is a pick and no snapshot yet.
    setClosed(true);
  }, []);

  /** Load whichever coin the feed handed over. */
  useEffect(() => {
    if (!picked) return;
    setSnap(null);
    setMsg(null);
    setRouteOk(null);
    setClosed(false);
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

  const address = key.address;
  const refresh = useCallback(async () => {
    void refreshBal();
    if (address && snap) {
      try {
        setHeld(
          (await browserPublic().readContract({
            address: getAddress(snap.address),
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
          })) as bigint,
        );
      } catch {
        setHeld(null);
      }
    } else setHeld(null);
  }, [address, snap, refreshBal]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const slippageBps = SLIPPAGE_PCT * 100;
  const amount = Number(eth) || 0;
  const overPerTrade = amount > limits.perTrade;
  const overDaily = spent + amount > limits.perDay;

  /**
   * Buy one coin, priced fresh at the moment of buying.
   *
   * Takes an address rather than the loaded snapshot, because the sniper buys
   * coins that were never loaded into the panel — it sees a launch in the feed
   * and has to act on it, and a feed row carries no reserves or fees. One
   * lookup gets the same snapshot the manual path uses, so there is a single
   * buying routine rather than two that could price the same trade differently.
   *
   * Throws on failure. The sniper needs to know a buy did not happen so it can
   * say so and leave the watch armed; the button below catches and displays.
   */
  const buyToken = useCallback(
    async (address: string, ethIn: string) => {
      if (!key.client || !key.address) throw new Error("wallet is locked");
      const r = await fetch(`/api/token?address=${address}`);
      const t = (await r.json()) as Snap & { error?: string };
      if (!r.ok) throw new Error(t.error ?? "lookup failed");
      if (!t.tradeable) throw new Error(t.reason ?? "not tradeable");

      const wei = parseEther(ethIn);
      const { hashes, spentQuote } = await executeBuy(key.client, key.address, wei, {
        curve: getAddress(t.curve),
        token: getAddress(t.address),
        pairToken: t.pairToken as Address,
        quoteIsNative: t.quoteIsNative,
        reserves: {
          quoteReserve: BigInt(t.reserves.quoteReserve),
          tokenReserve: BigInt(t.reserves.tokenReserve),
        },
        feeBps: t.feeBps,
        creatorTaxBps: t.creatorTaxBps,
        slippageBps,
      });
      key.touch();
      recordBuy(key.address, {
        token: t.address,
        curve: t.curve,
        symbol: t.symbol,
        decimals: t.decimals,
        quoteSymbol: t.quoteSymbol,
        quoteDecimals: t.quoteDecimals,
        quoteIsNative: t.quoteIsNative,
        // What reached the curve, which on a zapped buy is the swapped amount
        // rather than the ETH — the two are different assets entirely.
        spentQuote: spentQuote.toString(),
        spentEth: wei.toString(),
        at: Date.now(),
      });
      setMoved((n) => n + 1);
      return { symbol: t.symbol, tx: hashes[hashes.length - 1] };
    },
    [key, slippageBps],
  );

  const buy = async () => {
    if (!snap || overPerTrade || overDaily) return;
    setBusy("buy");
    setMsg(null);
    try {
      const done = await buyToken(snap.address, eth);
      addSpentToday(amount);
      syncSpent();
      setMsg({ kind: "ok", text: `Bought ${done.symbol}.`, tx: done.tx });
      void refresh();
    } catch (e) {
      setMsg({ kind: "err", text: (e instanceof Error ? e.message : "buy failed").split("\n")[0] });
    } finally {
      setBusy(null);
    }
  };

  /*
   * The sniper. Spends through the same routine as the button above, so a
   * sniped entry and a hand-pressed one cannot behave differently.
   */
  const sniper = useSniper(
    key.address,
    key.unlocked,
    limits,
    useCallback(
      async (token: string, ethIn: string) => {
        await buyToken(token, ethIn);
        syncSpent();
        void refresh();
      },
      [buyToken, syncSpent, refresh],
    ),
  );

  /* An armed watch or an armed sell rule both keep the wallet awake; with
     neither it goes back to idling out after fifteen minutes. Declared here
     rather than beside the sell rules because it reads `sniper`, which is
     defined just above — a hook cannot reach a const that has not run yet. */
  useEffect(
    () => key.setWatching(auto.armed + sniper.armed > 0),
    [auto.armed, sniper.armed, key.setWatching],
  );

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
      partial?: boolean;
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
      // Only forget a position that is actually gone. A partial sell leaves
      // tokens and a cost basis behind, and dropping the record would lose the
      // profit column on what is still held.
      if (!h.partial) forgetPosition(key.address, h.address);
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

  /*
   * Locked, but not hidden.
   *
   * This used to replace the whole panel with a connect button, so a first-time
   * visitor could not see the buy form, the spend presets or the sniper — the
   * three things that would make them want a wallet in the first place. You
   * cannot evaluate a tool you are not allowed to look at.
   *
   * So the interface stays on screen and only the controls are inert. One bar
   * at the top says what to do about it, and every action below is disabled
   * rather than absent.
   */
  const locked = !key.exists || !key.unlocked;

  // ── the panel, live or locked ───────────────────────────────────────────
  const canBuy =
    !locked &&
    !!snap &&
    snap.tradeable &&
    (snap.quoteIsNative || routeOk === true) &&
    !overPerTrade &&
    !overDaily &&
    busy === null;

  return (
    <aside className={`card${locked ? " is-locked" : ""}`}>
      {/* The address and balance live in the header pill now, so repeating
          them here would just be two places to disagree. */}
      <h2 className="shead">Trade</h2>

      {locked && (
        <div className="locked-bar">
          <p>
            {key.exists
              ? "Your wallet is locked. Unlock it to buy and to arm a snipe."
              : "Connect a wallet to buy in one click and snipe launches by ticker."}
          </p>
          <button className="btn btn-primary" onClick={openMenu}>
            {key.exists ? "Unlock wallet" : "Connect wallet"}
          </button>
        </div>
      )}

      {bal != null && bal === 0n && (
        <p className="note-warn">
          <strong>Your trading wallet is empty.</strong>{" "}
          <button className="linkish" onClick={openMenu}>
            Add funds
          </button>{" "}
          from your own wallet, or send ETH to it from anywhere.
        </p>
      )}

      {!snap ? (
        picked && !msg && !closed ? (
          /*
            Loading, and it says so.

            The lookup takes a beat — a token read plus, for a stock-quoted
            coin, a check that a swap route exists. Until now the panel showed
            "pick a coin from the feed" the entire time, so clicking a row
            looked like it had done nothing and people clicked again.
          */
          <div className="loading-coin" aria-busy="true">
            <span className="lc-bar lc-a" />
            <span className="lc-bar lc-b" />
            <span className="lc-bar lc-c" />
          </div>
        ) : (
          <p className="ssub" style={{ marginTop: 8 }}>
            Pick a coin from the feed to buy it — one click, no popup to confirm.
          </p>
        )
      ) : !snap.tradeable ? (
        <p className="note-warn">
          <strong>{snap.symbol} cannot be traded.</strong> {snap.reason ?? "The curve is closed."}
        </p>
      ) : (
        <>
          <div className="spread" style={{ marginTop: 10 }}>
            <strong>{snap.symbol}</strong>
            <div className="row" style={{ gap: 8 }}>
              <span className="muted small">
                {snap.quoteIsNative ? "ETH" : `via ${snap.quoteSymbol}`} ·{" "}
                {snap.graduation.progressPct.toFixed(1)}%
              </span>
              {/* A way back out. Picking a coin replaced the panel with that
                  coin and there was no way to put it down again short of
                  picking a different one — so a chart you opened to glance at
                  stayed open, polling, over the buy box. */}
              <button
                className="ch-x"
                onClick={closeCoin}
                aria-label={`Close ${snap.symbol}`}
                title="Close"
              >
                <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
                  <path
                    d="M3 3 L11 11 M11 3 L3 11"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          </div>

          {/* Above the buy box, not below it: the chart is what you look at
              before deciding the size, so putting it under the button would
              mean scrolling back up to check. */}
          <Chart address={snap.address} symbol={snap.symbol} />

          {!snap.quoteIsNative && routeOk === false && (
            <p className="note-warn">
              <strong>No route.</strong> This coin is priced in {snap.quoteSymbol} and there is no
              pool to swap ETH into it.
            </p>
          )}

          {/* Presets on their own row rather than trailing the input. In a
              narrower sidebar the four of them wrapped, leaving a lone 0.1
              sitting under the others like a mistake. */}
          <label className="field" style={{ marginTop: 10 }}>
            <span>Spend (ETH)</span>
            <input className="input" value={eth} onChange={(e) => setEth(e.target.value)} />
            <div className="presets">
              {PRESETS.map((v) => (
                <button
                  key={v}
                  className={`btn btn-sm btn-outline${eth === v ? " on" : ""}`}
                  onClick={() => setEth(v)}
                >
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
                            tpSellPct: rule?.tpSellPct ?? 100,
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
                            tpSellPct: rule?.tpSellPct ?? 100,
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>sell %</span>
                      <input
                        className="input"
                        inputMode="decimal"
                        placeholder="100"
                        defaultValue={rule?.tpSellPct ?? ""}
                        title="how much of this position the take profit sells"
                        onBlur={(e) =>
                          auto.save(h.token, {
                            tp: rule?.tp ?? null,
                            sl: rule?.sl ?? null,
                            tpSellPct: e.target.value.trim()
                              ? Math.max(1, Math.min(100, Number(e.target.value) || 100))
                              : 100,
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

      {/* ── snipe a coin you already know is coming ── */}
      <div className={`snipe${snipeFold.collapsed ? " is-collapsed" : ""}`}>
        <div className="card-head">
          <h3 className="shead">Snipe a launch</h3>
          <div className="row" style={{ gap: 8 }}>
            {sniper.armed > 0 && (
              <span className="chip chip-live">
                <span className="dot" />
                {sniper.armed} ARMED
              </span>
            )}
            <CollapseButton
              collapsed={snipeFold.collapsed}
              onToggle={snipeFold.toggle}
              label="snipe a launch"
            />
          </div>
        </div>
        <p className="ssub">
          For when you already know the ticker. It buys the moment that coin exists, without
          you watching for it.{" "}
          {locked && <button className="linkish" onClick={openMenu}>Connect a wallet to arm one.</button>}
        </p>

        <div className="snipe-form">
          <label className="field">
            <span>Ticker</span>
            <input
              className="input"
              placeholder="VLAD"
              value={wTicker}
              onChange={(e) => setWTicker(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Spend (ETH)</span>
            <input className="input" value={wEth} onChange={(e) => setWEth(e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>Dev wallet</span>
          <input
            className="input mono"
            placeholder="0x… the address you expect to launch it"
            value={wDev}
            onChange={(e) => setWDev(e.target.value)}
          />
        </label>

        {/* Set here, armed the instant the snipe fills. Leaving one empty means
            no rule of that kind — a decision the form lets you make rather than
            the state it starts in. */}
        <div className="snipe-form">
          <label className="field">
            <span>Take profit %</span>
            <input
              className="input"
              inputMode="decimal"
              placeholder="none"
              value={wTp}
              onChange={(e) => setWTp(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Stop loss %</span>
            <input
              className="input"
              inputMode="decimal"
              placeholder="none"
              value={wSl}
              onChange={(e) => setWSl(e.target.value)}
            />
          </label>
        </div>

        <label className="field">
          <span>
            Sell at take profit <i className="muted">— % of the position</i>
          </span>
          <input
            className="input"
            inputMode="decimal"
            value={wTpPct}
            onChange={(e) => setWTpPct(e.target.value)}
          />
        </label>
        <p className="ssub" style={{ marginTop: -6 }}>
          {Number(wTpPct) >= 100
            ? "Closes the whole position at the target."
            : `Sells ${Number(wTpPct) || 0}% at the target and leaves ${100 - (Number(wTpPct) || 0)}% running, still covered by the stop loss.`}
        </p>
        {/*
          Said at the point of the decision, not in a help page.

          Anyone can deploy a token with any ticker and they constantly do:
          VLAD has launched 530 times from different makers and TEST 605. A
          ticker-only watch will usually fire on a squatter rather than on the
          launch that was meant, which is a real way to lose money quietly.
        */}
        {!wDev.trim() && wTicker.trim() && (
          <p className="note-warn">
            <strong>Without a dev wallet this will buy the first coin called {wTicker.trim()}.</strong>{" "}
            That ticker has probably been used before — 530 different coins have been called
            VLAD. Pin the address if you know it.
          </p>
        )}
        <button
          className="btn btn-primary btn-lg"
          disabled={locked || !wTicker.trim() || !(Number(wEth) > 0)}
          onClick={() => {
            sniper.add({
              ticker: wTicker.trim(),
              deployer: wDev.trim(),
              eth: wEth,
              tp: wTp.trim() ? Math.abs(Number(wTp)) : null,
              sl: wSl.trim() ? Math.abs(Number(wSl)) : null,
              tpSellPct: Math.max(1, Math.min(100, Number(wTpPct) || 100)),
              maxBuys: 1,
              // A watch you set and forget should not fire next week.
              expiresAt: Date.now() + 24 * 3600_000,
            });
            setWTicker("");
            setWDev("");
          }}
        >
          Arm it
        </button>

        {sniper.watches.length > 0 && (
          <div className="watches">
            {sniper.watches.map((w) => {
              const spent = w.bought >= w.maxBuys;
              const expired = w.expiresAt <= Date.now();
              return (
                <div key={w.id} className={`watch${spent || expired ? " done" : ""}`}>
                  <span className="watch-tick">{w.ticker}</span>
                  <span className="muted small">
                    {w.eth} ETH ·{" "}
                    {w.deployer ? `from ${w.deployer.slice(0, 6)}…${w.deployer.slice(-4)}` : "any dev"}
                    {(w.tp != null || w.sl != null) && (
                      <>
                        {" · exit "}
                        {w.tp != null ? `+${w.tp}%` : "—"}/{w.sl != null ? `-${w.sl}%` : "—"}
                      </>
                    )}
                  </span>
                  <span className="watch-state small">
                    {spent ? "bought" : expired ? "expired" : "waiting"}
                  </span>
                  <button className="linkish" onClick={() => sniper.remove(w.id)}>
                    remove
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {sniper.armed > 0 && (
          <p className="muted small" style={{ marginTop: 8 }}>
            Checking every {Math.round(WATCH_POLL_MS / 1000)}s.{" "}
            <strong>Only while this tab is open</strong> — close it and nothing is sniped.
          </p>
        )}
        {sniper.firing && <p className="pos small">Buying now…</p>}
        {sniper.recent.map((h) => (
          <p key={h.at} className={h.ok ? "pos small" : "neg small"} style={{ marginTop: 4 }}>
            {h.ticker} — {h.detail}
          </p>
        ))}
      </div>

      <SniperRules sniper={sniper} locked={locked} onConnect={openMenu} />

    </aside>
  );
}
