"use client";

/**
 * The wallets in the vault, and the controls for adding and removing them.
 *
 * Lives inside the unlocked wallet menu rather than in a page of its own,
 * because it is the same object the pill already represents — a list of
 * wallets is what "your wallet" turns into once there can be more than one.
 *
 * Balances are read here rather than taken from the wallet context, which
 * tracks the primary only. They are the deciding number for both things a
 * person does on this screen: which wallet to spend from, and whether it is
 * safe to remove one.
 */
import { useCallback, useEffect, useState } from "react";
import { formatEther, type Address } from "viem";
import { browserPublic } from "./browserTrade";
import type { TradingKey } from "./useTradingKey";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Four decimals, which at these balances is the difference that matters. */
function eth(v: bigint | undefined): string {
  if (v == null) return "—";
  return `${Number(formatEther(v)).toFixed(4)} ETH`;
}

export default function WalletList({ k }: { k: TradingKey }) {
  const [bals, setBals] = useState<Record<string, bigint>>({});
  const [importing, setImporting] = useState(false);
  const [pk, setPk] = useState("");
  /** The address awaiting a second click, so removal is never one press. */
  const [confirming, setConfirming] = useState<Address | null>(null);

  const addresses = k.addresses;
  const joined = addresses.join(",");

  /*
   * One read per wallet, batched by the transport into a single request.
   *
   * Re-run when the set changes rather than on a timer: this menu is open for
   * seconds at a time, and a wallet's balance moving while somebody looks at
   * the list is not worth a poll against the public endpoints.
   */
  const load = useCallback(async () => {
    const c = browserPublic();
    const found = await Promise.all(
      addresses.map(async (a) => {
        try {
          return [a, await c.getBalance({ address: a })] as const;
        } catch {
          // One unreachable balance must not blank the whole list.
          return [a, undefined] as const;
        }
      }),
    );
    setBals(Object.fromEntries(found.filter(([, v]) => v != null) as [string, bigint][]));
  }, [addresses]);

  useEffect(() => {
    void load();
    // joined, not addresses: the array is rebuilt on every render and would
    // otherwise re-read every balance each time the menu re-rendered.
  }, [joined, load]);

  const remove = async (a: Address) => {
    setConfirming(null);
    await k.removeWallet(a);
  };

  return (
    <div className="wl">
      <div className="wl-head">
        <span className="wl-title">
          Wallets <b>{addresses.length}</b>
        </span>
        <button
          className="linkish"
          onClick={() => void k.addWallet()}
          disabled={k.busy}
        >
          + new wallet
        </button>
      </div>

      <ul className="wl-rows">
        {addresses.map((a, i) => {
          const bal = bals[a];
          const empty = bal != null && bal === 0n;
          return (
            <li key={a} className="wl-row">
              <button
                className="wl-addr mono"
                title={`${a} — click to copy`}
                onClick={() => void navigator.clipboard?.writeText(a).catch(() => {})}
              >
                {short(a)}
              </button>
              {/* The first wallet is the one every single-wallet part of the
                  app acts on, so it is worth saying which that is. */}
              {i === 0 && <span className="wl-tag">primary</span>}
              <span className="wl-bal num">{eth(bal)}</span>

              {addresses.length > 1 &&
                (confirming === a ? (
                  <span className="wl-confirm">
                    {/*
                      The key exists in this browser and nowhere else, so
                      removing it is not tidying — it is the end of any access
                      to whatever that address holds. Said at the moment of the
                      decision, and only when there is something to lose.
                    */}
                    <b>{empty ? "Remove it?" : "Balance will be lost."}</b>
                    <button className="linkish danger" onClick={() => void remove(a)}>
                      {empty ? "yes" : "remove anyway"}
                    </button>
                    <button className="linkish" onClick={() => setConfirming(null)}>
                      cancel
                    </button>
                  </span>
                ) : (
                  <button
                    className="wl-x"
                    aria-label={`Remove ${short(a)}`}
                    title="Remove this wallet"
                    onClick={() => setConfirming(a)}
                    disabled={k.busy}
                  >
                    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                      <path
                        d="M3 3 L9 9 M9 3 L3 9"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                ))}
            </li>
          );
        })}
      </ul>

      {importing ? (
        <div className="wl-import">
          <input
            className="input"
            placeholder="0x… private key"
            value={pk}
            onChange={(e) => setPk(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn btn-sm"
              disabled={k.busy || !pk.trim()}
              onClick={async () => {
                await k.addWallet(pk);
                setPk("");
                setImporting(false);
              }}
            >
              Add it
            </button>
            <button
              className="linkish"
              onClick={() => {
                setPk("");
                setImporting(false);
              }}
            >
              cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="linkish wl-alt" onClick={() => setImporting(true)}>
          or import a private key
        </button>
      )}
    </div>
  );
}
