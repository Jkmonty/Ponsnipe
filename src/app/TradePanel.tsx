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
  useEffect(() => key.setWatching(auto.armed > 0), [auto.armed, key.setWatching]);

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
      syncSpent();
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

  /*
   * No wallet yet, or locked: point at the button rather than becoming it.
   *
   * The panel used to replace itself with a signup form here, so someone who
   * had just clicked a coin was shown a passphrase field instead of the coin.
   * Now the coin stays on screen and the wallet is one click away in the
   * header, which is also where it will be next time they need it.
   */
  if (!key.exists || !key.unlocked) {
    return (
      <aside className="card">
        <h2 className="shead">Trade</h2>
        {snap ? (
          <p className="ssub">
            <strong>{snap.symbol}</strong> is ready to buy.{" "}
            {key.exists ? "Unlock your wallet" : "Connect a wallet"} to take the shot.
          </p>
        ) : (
          <p className="ssub">
            {key.exists
              ? "Unlock your wallet, then pick a coin from the feed."
              : "Connect a wallet, then pick a coin from the feed to buy it in one click."}
          </p>
        )}
        <button className="btn btn-primary btn-lg" onClick={openMenu}>
          {key.exists ? "Unlock wallet" : "Connect wallet"}
        </button>
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
      {/* The address and balance live in the header pill now, so repeating
          them here would just be two places to disagree. */}
      <h2 className="shead">Trade</h2>

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

    </aside>
  );
}
