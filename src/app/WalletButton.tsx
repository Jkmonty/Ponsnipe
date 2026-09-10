"use client";

/**
 * The connect button, where everyone already looks for it.
 *
 * Every exchange a trader has used puts this in the top-right corner: one
 * pill, showing an address and a balance once connected. Ponsnipe put it in
 * the sidebar as three paragraphs of explanation, which had two costs — the
 * trading panel could not be seen until you had read them, and a stranger had
 * to be persuaded before they were allowed to look around.
 *
 * The explanation has not been deleted, because it is the one place someone is
 * told that a browser key is not MetaMask. It has moved to the moment it is
 * actually needed: the menu you open to create the wallet, one sentence up
 * front and the detail a click away.
 */
import { useEffect, useRef, useState } from "react";
import { formatEther, parseEther } from "viem";
import { robinhoodChain } from "@/lib/chain";
import { browserPublic } from "./browserTrade";
import { useWallet } from "./WalletContext";
import { REVEAL_TIMEOUT_MS } from "./useTradingKey";
import WalletList from "./WalletList";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function WalletButton({ localInstall = false }: { localInstall?: boolean }) {
  const { key, ext, bal, refreshBal, limits, setLimits, spent, menu, setMenu } = useWallet();
  const [pass, setPass] = useState("");
  const [importPk, setImportPk] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [fundEth, setFundEth] = useState("0.05");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [revealPass, setRevealPass] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  /* Read after mount for the same reason `secure` is: the server has no window. */
  const [origin, setOrigin] = useState("this address");
  useEffect(() => setOrigin(window.location.origin), []);

  /* Close on a click anywhere else, and on Escape — a menu holding a
     passphrase field should not need aiming at to dismiss. */
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setMenu(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [menu, setMenu]);

  /* Nothing typed here outlives the menu being closed. */
  useEffect(() => {
    if (menu) return;
    setPass("");
    setImportPk("");
    setRevealPass(null);
    setRevealed(null);
    setNote(null);
    setCopied(false);
  }, [menu]);

  /* Take the key back off the screen on its own, rather than when someone
     remembers to press hide. */
  useEffect(() => {
    if (!revealed) return;
    const t = setTimeout(() => setRevealed(null), REVEAL_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [revealed]);

  /** Move ETH from the trader's real wallet into the trading key. */
  const fund = async () => {
    if (!ext.client || !ext.address || !key.address) return;
    setBusy("fund");
    setNote(null);
    try {
      /*
       * The chain is named, not left to whatever the wallet is on.
       *
       * This was `chain: null`, which tells viem to skip the check and send on
       * the connected network — so with MetaMask on mainnet the ETH went to
       * the right address on the wrong ledger, three times, while every
       * confirmation screen looked correct. Naming it makes the wallet prompt
       * to switch instead of quietly obeying. The withdraw below always named
       * it; this was the odd one out.
       */
      if (ext.chainId !== robinhoodChain.id) await ext.switchChain();
      const hash = await ext.client.sendTransaction({
        account: ext.address,
        chain: robinhoodChain,
        to: key.address,
        value: parseEther(fundEth),
      });
      setNote("Sent. Waiting for it to land…");
      await browserPublic().waitForTransactionReceipt({ hash });
      setNote(`Funded with ${fundEth} ETH.`);
      void refreshBal();
    } catch (e) {
      const m = e instanceof Error ? e.message : "funding failed";
      // A rejected signature is a decision, not an error worth reporting back.
      setNote(/rejected|denied|4001/i.test(m) ? null : m.split("\n")[0]);
    } finally {
      setBusy(null);
    }
  };

  /** Send everything back, less a little for the gas of doing so. */
  const withdraw = async () => {
    if (!key.client || !key.address || !ext.address || !bal) return;
    setBusy("withdraw");
    setNote(null);
    try {
      const c = browserPublic();
      const fee = 21_000n * (await c.getGasPrice()) * 2n;
      if (bal <= fee) throw new Error("balance is too small to cover the transfer fee");
      const hash = await key.client.sendTransaction({
        account: key.account!,
        chain: robinhoodChain,
        to: ext.address,
        value: bal - fee,
      });
      await c.waitForTransactionReceipt({ hash });
      setNote(`Sent back to ${short(ext.address)}.`);
      void refreshBal();
    } catch (e) {
      setNote((e instanceof Error ? e.message : "withdraw failed").split("\n")[0]);
    } finally {
      setBusy(null);
    }
  };

  const ethText = bal != null ? `${Number(formatEther(bal)).toFixed(4)} ETH` : "…";

  const label = !key.exists ? (
    "Connect wallet"
  ) : !key.unlocked ? (
    <>
      <span className="wb-dot locked" />
      Unlock
    </>
  ) : (
    <>
      <span className="wb-dot" />
      <span className="wb-bal num">{ethText}</span>
      <span className="wb-addr mono">{key.address ? short(key.address) : ""}</span>
    </>
  );

  return (
    <div className="wb" ref={box}>
      <button
        className={`wb-pill${!key.exists ? " wb-cta" : ""}${menu ? " open" : ""}`}
        onClick={() => setMenu(!menu)}
        title={key.address ?? "Create a trading wallet in this browser"}
      >
        {label}
      </button>

      {menu && (
        <div className="wb-menu" role="dialog" aria-label="Wallet">
          {/* ── nothing yet: create or import ── */}
          {/*
            No certificate, no wallet.
            
            WebCrypto only exists in a secure context, so on plain HTTP over an
            IP address crypto.subtle is undefined and every key operation dies
            with "Cannot read properties of undefined". Said here rather than
            thrown from a click, because it is not a fault the reader can fix by
            trying again — and localhost is a secure context, which is why this
            only ever appears on a deployed site.
          */}
          {!key.secure && (
            <div className="wb-insecure">
              <h3>This needs HTTPS</h3>
              <p className="wb-lead">
                A browser only allows the encryption this wallet is built on over a
                secure connection. On <span className="mono">{origin}</span> it is not
                available, so a key cannot be created or unlocked here.
              </p>
              <p className="wb-fine">
                Nothing is wrong with your browser or your wallet. The site needs a
                domain with a certificate, and this comes back on its own once it has
                one.
              </p>
            </div>
          )}

          {key.secure && !key.exists && (
            <>
              <h3>Trading wallet</h3>
              <p className="wb-lead">
                A wallet that lives in this browser, so buying is one click with nothing to
                confirm. Your normal wallet fills it and empties it.
              </p>
              <p className="wb-fine">
                Keep only what you are actively trading in it, the same as any hot wallet.
              </p>
              {/* Otherwise this is a trap on a local install: you can make a
                  wallet and fund it, and then find there is no browser buy
                  form to spend it from, because buying here goes through the
                  bot wallet the engine controls. */}
              {localInstall && (
                <p className="wb-note-local">
                  On your own copy, buying and the sniper run through the bot wallet below.
                  This is the wallet visitors to your hosted site get — make one to see what
                  they see.
                </p>
              )}
              <details className="fineprint">
                <summary>How it works, and what to watch</summary>
                <p>
                  The key is made here and encrypted with your passphrase before it is saved. It
                  never leaves your browser and this site never receives it. It relocks after
                  fifteen minutes without a trade, and you can set per-trade and daily spend
                  limits.
                </p>
                <p>
                  Two things to know. Clearing this site&rsquo;s data deletes the key, so back it
                  up if the balance matters. And while it is unlocked, anything able to run
                  script on this page could spend it — which is why it is for a trading float
                  rather than savings.
                </p>
              </details>
              <label className="field">
                <span>Passphrase (12+ characters)</span>
                <input
                  className="input"
                  type="password"
                  autoFocus
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  onKeyDown={(e) =>
                    e.key === "Enter" &&
                    void (showImport ? key.importKey(importPk, pass) : key.create(pass))
                  }
                />
              </label>
              {showImport && (
                <label className="field">
                  <span>Private key to import</span>
                  <input
                    className="input mono"
                    value={importPk}
                    onChange={(e) => setImportPk(e.target.value)}
                  />
                </label>
              )}
              <button
                className="btn btn-primary btn-lg"
                disabled={key.busy || pass.length < 12}
                onClick={() => void (showImport ? key.importKey(importPk, pass) : key.create(pass))}
              >
                {key.busy ? "…" : showImport ? "Import wallet" : "Create wallet"}
              </button>
              <button className="linkish wb-alt" onClick={() => setShowImport((v) => !v)}>
                {showImport ? "or create a new one" : "or import a private key"}
              </button>
            </>
          )}

          {/* ── locked ── */}
          {key.secure && key.exists && !key.unlocked && (
            <>
              <h3>Unlock</h3>
              <p className="wb-lead mono">{key.address ? short(key.address) : ""}</p>
              <label className="field">
                <span>Passphrase</span>
                <input
                  className="input"
                  type="password"
                  autoFocus
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void key.unlock(pass)}
                />
              </label>
              <button
                className="btn btn-primary btn-lg"
                disabled={key.busy}
                onClick={() => void key.unlock(pass)}
              >
                {key.busy ? "…" : "Unlock"}
              </button>
              <button
                className="linkish wb-alt"
                onClick={() => {
                  if (
                    confirm(
                      "Delete this trading wallet from the browser? Any funds still in it are lost unless you have the key backed up.",
                    )
                  )
                    key.forget();
                }}
              >
                forget this wallet
              </button>
            </>
          )}

          {/* ── unlocked ── */}
          {key.secure && key.unlocked && (
            <>
              {/* Copyable, because the alternative was telling someone to send
                  ETH to "0x9EcD…BD86" — an address they can read and cannot
                  use. Clicking it puts the full thing on the clipboard. */}
              <div className="wb-head">
                <button
                  className="wb-copy mono"
                  title={key.address ?? ""}
                  onClick={() => {
                    if (!key.address) return;
                    void navigator.clipboard
                      ?.writeText(key.address)
                      .then(() => setCopied(true))
                      .catch(() => setNote("Could not reach the clipboard — copy it from the tooltip."));
                  }}
                >
                  {key.address ? short(key.address) : ""}
                  <span className="wb-copy-hint">{copied ? "copied" : "copy"}</span>
                </button>
                <strong className="num">{ethText}</strong>
              </div>
              {key.lockingIn != null && (
                <p className="wb-fine">
                  Locks after {Math.ceil(key.lockingIn / 60_000)} more minutes without a trade.
                </p>
              )}

              {/* The list appears once there is a choice to make. With a single
                  wallet the head above already says everything it would. */}
              {key.addresses.length > 1 ? (
                <WalletList k={key} />
              ) : (
                <button className="linkish wb-alt" onClick={() => void key.addWallet()}>
                  add another wallet
                </button>
              )}

              {ext.address ? (
                <>
                  <label className="field">
                    <span>Add from {short(ext.address)}</span>
                    <div className="row" style={{ gap: 8 }}>
                      <input
                        className="input"
                        value={fundEth}
                        onChange={(e) => setFundEth(e.target.value)}
                        style={{ maxWidth: 110 }}
                      />
                      <button className="btn btn-sm" onClick={() => void fund()} disabled={!!busy}>
                        {busy === "fund" ? "Confirm in wallet…" : "Send"}
                      </button>
                    </div>
                  </label>
                  <button
                    className="btn btn-sm btn-outline wb-wide"
                    onClick={() => void withdraw()}
                    disabled={!!busy || !bal}
                  >
                    {busy === "withdraw" ? "Sending…" : "Send everything back"}
                  </button>
                </>
              ) : (
                <button className="btn btn-sm wb-wide" onClick={() => void ext.connect()}>
                  {ext.available
                    ? "Connect MetaMask to add funds"
                    : "No browser wallet here — copy the address above and send ETH to it"}
                </button>
              )}

              <div className="row wb-limits">
                <label className="field">
                  <span>Max per trade</span>
                  <input
                    className="input"
                    value={limits.perTrade}
                    onChange={(e) => setLimits({ ...limits, perTrade: Number(e.target.value) || 0 })}
                  />
                </label>
                <label className="field">
                  <span>Max per day</span>
                  <input
                    className="input"
                    value={limits.perDay}
                    onChange={(e) => setLimits({ ...limits, perDay: Number(e.target.value) || 0 })}
                  />
                </label>
              </div>
              <p className="wb-fine">
                Spent today: {spent.toFixed(4)} ETH. Set a cap to <b>0</b> for no limit.
              </p>

              <div className="wb-foot">
                <button
                  className="linkish"
                  onClick={() => setRevealPass(revealPass == null ? "" : null)}
                >
                  Back up key
                </button>
                <button className="linkish" onClick={key.lock}>
                  Lock
                </button>
              </div>
              {revealPass != null && !revealed && (
                <div className="row" style={{ gap: 8, marginTop: 6 }}>
                  <input
                    className="input"
                    type="password"
                    autoFocus
                    placeholder="Passphrase"
                    value={revealPass}
                    onChange={(e) => setRevealPass(e.target.value)}
                    onKeyDown={(e) =>
                      e.key === "Enter" && void key.reveal(revealPass).then(setRevealed)
                    }
                  />
                  <button
                    className="btn btn-sm"
                    onClick={() => void key.reveal(revealPass).then(setRevealed)}
                  >
                    Show
                  </button>
                </div>
              )}
              {revealed && (
                <p className="note-warn mono wb-secret">
                  {revealed}
                  <br />
                  <button
                    className="linkish"
                    onClick={() => {
                      setRevealed(null);
                      setRevealPass(null);
                    }}
                  >
                    hide
                  </button>
                </p>
              )}
            </>
          )}

          {(note || key.error) && <p className="wb-fine wb-note">{note ?? key.error}</p>}
        </div>
      )}
    </div>
  );
}
