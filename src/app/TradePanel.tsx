"use client";

/**
 * Buy and sell from the hosted feed, signed by the visitor's own wallet.
 *
 * Nothing here touches a key. Quotes are computed from the curve's reserves
 * with the same functions the local engine uses, and the transaction is handed
 * to the browser wallet to sign — so a hosted instance can be traded through
 * without the app ever holding funds, and without anyone installing anything.
 *
 * What this deliberately does NOT do is sell for you while you are away. That
 * needs a key that can sign unattended, which is the whole reason the local
 * install exists. A page cannot promise it.
 */
import { useCallback, useEffect, useState } from "react";
import { formatEther, formatUnits, getAddress, parseEther, type Address } from "viem";
import { bondingCurveAbi, erc20Abi } from "@/lib/pons/abis";
import { applySlippage, quoteBuy, quoteSell } from "@/lib/pons/pricing";
import { readClient } from "@/lib/chain";
import { useBrowserWallet } from "./useBrowserWallet";

interface Snap {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  curve: string;
  pairToken: string;
  quoteSymbol: string;
  quoteDecimals: number;
  quoteIsNative: boolean;
  feeBps: number;
  creatorTaxBps: number;
  reserves: { quoteReserve: string; tokenReserve: string };
  price: { priceQuote: number };
  graduation: { progressPct: number };
  tradeable: boolean;
  reason?: string;
}

const EXPLORER = "https://robinhoodchain.blockscout.com";
const PRESETS = ["0.005", "0.01", "0.05", "0.1"];

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export default function TradePanel({ picked }: { picked: { address: string; n: number } | null }) {
  const w = useBrowserWallet();
  const [snap, setSnap] = useState<Snap | null>(null);
  const [eth, setEth] = useState("0.01");
  const [slipPct, setSlipPct] = useState("8");
  const [busy, setBusy] = useState<null | "buy" | "sell" | "approve">(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string; tx?: string } | null>(null);
  const [held, setHeld] = useState<bigint | null>(null);
  const [ethBal, setEthBal] = useState<bigint | null>(null);

  /** Load the coin the feed just handed us. */
  useEffect(() => {
    if (!picked) return;
    setSnap(null);
    setMsg(null);
    void (async () => {
      try {
        const r = await fetch(`/api/token?address=${picked.address}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "lookup failed");
        setSnap(j);
      } catch (e) {
        setMsg({ kind: "err", text: e instanceof Error ? e.message : "lookup failed" });
      }
    })();
  }, [picked]);

  /** The trader's balances: native ETH, and this token if they hold any. */
  const refreshBalances = useCallback(async () => {
    if (!w.address) return;
    const c = readClient();
    try {
      setEthBal(await c.getBalance({ address: w.address }));
    } catch {
      setEthBal(null);
    }
    if (!snap) return setHeld(null);
    try {
      setHeld(
        (await c.readContract({
          address: getAddress(snap.address),
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [w.address],
        })) as bigint,
      );
    } catch {
      setHeld(null);
    }
  }, [w.address, snap]);

  useEffect(() => {
    void refreshBalances();
  }, [refreshBalances]);

  const slippageBps = Math.round((Number(slipPct) || 0) * 100);

  /*
   * Quoted from the curve's own reserves with the functions the engine uses,
   * so what the panel promises and what the contract does cannot drift apart.
   */
  const buyPreview = (() => {
    if (!snap?.reserves) return null;
    try {
      const q = quoteBuy(
        parseEther(eth || "0"),
        {
          quoteReserve: BigInt(snap.reserves.quoteReserve),
          tokenReserve: BigInt(snap.reserves.tokenReserve),
        },
        BigInt(snap.feeBps),
        BigInt(snap.creatorTaxBps),
      );
      return q.tokensOut > 0n ? q : null;
    } catch {
      return null;
    }
  })();

  const sellPreview = (() => {
    if (!snap?.reserves || !held || held <= 0n) return null;
    try {
      return quoteSell(
        held,
        {
          quoteReserve: BigInt(snap.reserves.quoteReserve),
          tokenReserve: BigInt(snap.reserves.tokenReserve),
        },
        BigInt(snap.feeBps),
        BigInt(snap.creatorTaxBps),
      );
    } catch {
      return null;
    }
  })();

  const buy = async () => {
    if (!snap || !w.client || !w.address || !buyPreview) return;
    setBusy("buy");
    setMsg(null);
    try {
      const value = parseEther(eth);
      const minOut = applySlippage(buyPreview.tokensOut, slippageBps);
      if (minOut <= 0n) throw new Error("slippage leaves no minimum — raise the amount");
      const hash = await w.client.writeContract({
        account: w.address,
        chain: null,
        address: getAddress(snap.curve),
        abi: bondingCurveAbi,
        functionName: "buy",
        args: [value, minOut, w.address],
        value,
      });
      setMsg({ kind: "ok", text: `Buy sent for ${snap.symbol}.`, tx: hash });
      await readClient().waitForTransactionReceipt({ hash });
      setMsg({ kind: "ok", text: `Bought ${snap.symbol}.`, tx: hash });
      void refreshBalances();
    } catch (e) {
      const m = e instanceof Error ? e.message : "buy failed";
      // A rejected signature is a decision, not a failure.
      setMsg(/rejected|denied|4001/i.test(m) ? null : { kind: "err", text: m.split("\n")[0] });
    } finally {
      setBusy(null);
    }
  };

  const sell = async () => {
    if (!snap || !w.client || !w.address || !held || held <= 0n || !sellPreview) return;
    setBusy("sell");
    setMsg(null);
    try {
      const token = getAddress(snap.address);
      const curve = getAddress(snap.curve);
      const c = readClient();

      /*
       * The curve moves the tokens, so it needs an allowance first. Approving
       * exactly what is being sold rather than an unlimited amount: this is
       * somebody else's wallet on a site they have just met, and an infinite
       * approval to a curve contract outlives the trade.
       */
      const allowance = (await c.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [w.address, curve],
      })) as bigint;

      if (allowance < held) {
        setBusy("approve");
        const ap = await w.client.writeContract({
          account: w.address,
          chain: null,
          address: token,
          abi: erc20Abi,
          functionName: "approve",
          args: [curve, held],
        });
        setMsg({ kind: "ok", text: "Approving the curve to sell…", tx: ap });
        await c.waitForTransactionReceipt({ hash: ap });
        setBusy("sell");
      }

      const minOut = applySlippage(sellPreview.quoteOut, slippageBps);
      const hash = await w.client.writeContract({
        account: w.address,
        chain: null,
        address: curve,
        abi: bondingCurveAbi,
        functionName: "sell",
        args: [held, minOut, w.address],
      });
      setMsg({ kind: "ok", text: `Sell sent for ${snap.symbol}.`, tx: hash });
      await c.waitForTransactionReceipt({ hash });
      setMsg({ kind: "ok", text: `Sold ${snap.symbol}.`, tx: hash });
      void refreshBalances();
    } catch (e) {
      const m = e instanceof Error ? e.message : "sell failed";
      setMsg(/rejected|denied|4001/i.test(m) ? null : { kind: "err", text: m.split("\n")[0] });
    } finally {
      setBusy(null);
    }
  };

  // ── not connected ───────────────────────────────────────────────────────
  if (!w.address) {
    return (
      <aside className="card">
        <h2 className="shead">Trade from here</h2>
        <p className="ssub">
          Connect your own wallet and buy straight from the feed. This site never holds your
          keys, and every transaction is signed by you.
        </p>
        {w.available ? (
          <button className="btn btn-primary btn-lg" onClick={() => void w.connect()} disabled={w.connecting}>
            {w.connecting ? "Check your wallet…" : "Connect wallet"}
          </button>
        ) : (
          <p className="note-warn">
            <strong>No wallet detected.</strong> Install MetaMask or Rabby and reload this
            page. On a phone, open this link inside your wallet&rsquo;s own browser.
          </p>
        )}
        {w.error && <p className="neg small">{w.error}</p>}
        <p className="muted small" style={{ marginBottom: 0 }}>
          Buying is manual here. Automatic take-profit and stop-loss need a key that can sign
          while you are away, which only the version you run yourself can do.
        </p>
      </aside>
    );
  }

  // ── wrong network ───────────────────────────────────────────────────────
  if (!w.onRightChain) {
    return (
      <aside className="card">
        <h2 className="shead">Wrong network</h2>
        <p className="ssub">
          Your wallet is on chain {w.chainId ?? "?"}. pons lives on Robinhood Chain.
        </p>
        <button className="btn btn-primary btn-lg" onClick={() => void w.switchChain()}>
          Switch to Robinhood Chain
        </button>
        {w.error && <p className="neg small">{w.error}</p>}
      </aside>
    );
  }

  // ── connected ───────────────────────────────────────────────────────────
  return (
    <aside className="card">
      <div className="spread" style={{ alignItems: "center" }}>
        <h2 className="shead" style={{ margin: 0 }}>
          Trade
        </h2>
        <span className="muted small mono" title={w.address}>
          {short(w.address)}
          {ethBal != null ? ` · ${Number(formatEther(ethBal)).toFixed(4)} ETH` : ""}
        </span>
      </div>

      {!snap ? (
        <p className="ssub" style={{ marginTop: 8 }}>
          Pick a coin from the feed to trade it.
        </p>
      ) : !snap.tradeable ? (
        <p className="note-warn">
          <strong>{snap.symbol} cannot be traded.</strong> {snap.reason ?? "The curve is closed."}
        </p>
      ) : !snap.quoteIsNative ? (
        <p className="note-warn">
          <strong>{snap.symbol} is priced in {snap.quoteSymbol}, not ETH.</strong> Buying it
          needs a swap into {snap.quoteSymbol} first, which the version you run yourself does
          automatically. Not available from this page yet.
        </p>
      ) : (
        <>
          <div className="spread" style={{ marginTop: 10 }}>
            <strong>{snap.symbol}</strong>
            <span className="muted small">{snap.graduation.progressPct.toFixed(1)}% to graduation</span>
          </div>

          <label className="field" style={{ marginTop: 12 }}>
            <span>Spend (ETH)</span>
            <div className="row" style={{ gap: 8 }}>
              <input
                className="input"
                value={eth}
                onChange={(e) => setEth(e.target.value)}
                style={{ maxWidth: 130 }}
              />
              {PRESETS.map((v) => (
                <button key={v} className="btn btn-sm btn-outline" onClick={() => setEth(v)}>
                  {v}
                </button>
              ))}
            </div>
          </label>

          <label className="field">
            <span>Max slippage %</span>
            <input
              className="input"
              value={slipPct}
              onChange={(e) => setSlipPct(e.target.value)}
              style={{ maxWidth: 90 }}
            />
          </label>

          {buyPreview && (
            <p className="muted small">
              About {Number(formatUnits(buyPreview.tokensOut, snap.decimals)).toLocaleString(undefined, {
                maximumFractionDigits: 0,
              })}{" "}
              {snap.symbol}. Fee {(snap.feeBps / 100).toFixed(1)}%, creator tax{" "}
              {(snap.creatorTaxBps / 100).toFixed(1)}%.
            </p>
          )}

          <button
            className="btn btn-primary btn-lg"
            onClick={() => void buy()}
            disabled={busy !== null || !buyPreview}
          >
            {busy === "buy" ? "Confirm in your wallet…" : `Buy ${snap.symbol}`}
          </button>

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
              {sellPreview && (
                <p className="muted small" style={{ marginTop: 4 }}>
                  Worth about {Number(formatUnits(sellPreview.quoteOut, snap.quoteDecimals)).toFixed(5)} ETH
                  now.
                </p>
              )}
              <button
                className="btn btn-lg"
                onClick={() => void sell()}
                disabled={busy !== null}
                style={{ marginTop: 6 }}
              >
                {busy === "approve"
                  ? "Approving…"
                  : busy === "sell"
                    ? "Confirm in your wallet…"
                    : `Sell all ${snap.symbol}`}
              </button>
            </div>
          )}
        </>
      )}

      {msg && (
        <p className={msg.kind === "ok" ? "pos small" : "neg small"} style={{ marginBottom: 0 }}>
          {msg.text}{" "}
          {msg.tx && (
            <a href={`${EXPLORER}/tx/${msg.tx}`} target="_blank" rel="noopener noreferrer">
              view ↗
            </a>
          )}
        </p>
      )}

      <p className="muted small" style={{ marginTop: 12, marginBottom: 0 }}>
        Manual only. Automatic take-profit and stop-loss need a key that signs while you sleep,
        which only the version you run yourself has.{" "}
        <button className="linkish" onClick={w.disconnect}>
          forget wallet
        </button>
      </p>
    </aside>
  );
}
