"use client";

/**
 * A trading key that lives in the trader's browser.
 *
 * This is the answer to "why is MetaMask so slow". It is not slow — it is
 * asking, and asking is the point of it. Every buy is a popup, a read and a
 * click, which is several seconds on a chain where the coin you are looking at
 * is four seconds old.
 *
 * The instant alternative on other terminals is custody: you deposit, they
 * hold the funds, and a click executes server-side with their key. This does
 * the same thing without the custody. The key is generated in the browser,
 * encrypted with a passphrase, stored in localStorage and unlocked once per
 * session — so a buy is signed locally and broadcast straight to the chain
 * with nothing to confirm. It never leaves the machine and this app never
 * sees it; there is no request that could carry it, because signing happens
 * before anything is sent.
 *
 * What that costs, stated plainly because it is a real cost: a key in a
 * browser is weaker than a hardware wallet or an extension. Anyone who can run
 * script on this page while it is unlocked can use it, and clearing site data
 * destroys it. It is a hot wallet for the amount being actively traded, which
 * is exactly what the local install's bot wallet is, and it carries the same
 * rule — do not keep more in it than you are trading.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createWalletClient,
  type Account,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { robinhoodChain } from "@/lib/chain";
import {
  addressesOf,
  keyFrom,
  makeVault,
  normalisePrivateKey,
  openVault,
  resealVault,
  unb64,
  type Vault,
} from "./vault";
import { broadcastTransport } from "./browserTrade";

const STORE = "ponsnipe.tradingKey.v1";

/**
 * Lock the key again after this long without a trade.
 *
 * An unlocked key spends without confirming, so leaving one unlocked in a
 * forgotten tab is the same as leaving a wallet open on the desk. Fifteen
 * minutes is longer than a trade takes and shorter than a lunch.
 */
const IDLE_LOCK_MS = 15 * 60_000;

/**
 * The idle window while take-profit or stop-loss rules are armed.
 *
 * Arming a rule is asking this tab to act while you are not watching, so the
 * fifteen-minute lock would quietly disarm the very thing you set up — a
 * stop-loss that stops existing after a quarter of an hour is worse than no
 * stop-loss, because you believe it is there. Longer, but still finite: a tab
 * forgotten overnight should not be able to trade in the morning.
 */
const WATCHING_LOCK_MS = 8 * 60 * 60_000;

/**
 * How long a revealed private key stays on screen.
 *
 * Long enough to copy into a password manager, short enough that it is not
 * still sitting in the DOM an hour later on a shared machine.
 */
export const REVEAL_TIMEOUT_MS = 60_000;

/*
 * The endpoint list and the broadcast transport both live in browserTrade,
 * which is where the reads already pool across them.
 *
 * This file used to keep its own copy of the list and then send to the first
 * entry only — the comment claimed "the others follow it" and nothing did. A
 * single public node with no fallback is a poor place to put the one request
 * that costs money if it fails.
 */

function readVault(): Vault | null {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as Vault) : null;
  } catch {
    return null;
  }
}

export interface TradingKey {
  /** A vault exists in this browser, locked or not. */
  exists: boolean;
  /** Milliseconds until the idle lock fires, or null while locked. */
  lockingIn: number | null;
  /** Address of the primary key, known even while locked. */
  address: Address | null;
  /** Every address in the vault, in order, known even while locked. */
  addresses: Address[];
  /** Every unlocked account. Empty while locked. */
  accounts: Account[];
  /** One signing client per unlocked account, same order as `accounts`. */
  clients: WalletClient[];
  /** Generate a wallet, or import one, into an unlocked vault. */
  addWallet: (privateKey?: string) => Promise<void>;
  /** Drop a wallet. Its key is destroyed with it. */
  removeWallet: (address: Address) => Promise<void>;
  /** Unlocked and ready to sign without prompting. */
  unlocked: boolean;
  busy: boolean;
  error: string | null;
  create: (pass: string) => Promise<void>;
  importKey: (privateKey: string, pass: string) => Promise<void>;
  unlock: (pass: string) => Promise<void>;
  lock: () => void;
  /** The raw keys, one per line, for backing up or sweeping elsewhere. */
  reveal: (pass: string) => Promise<string | null>;
  forget: () => void;
  /** Push the idle deadline out; call when the key is used. */
  touch: () => void;
  /** Tell the lock that rules are armed, so it uses the longer window. */
  setWatching: (on: boolean) => void;
  account: Account | null;
  client: WalletClient | null;
}

export function useTradingKey(): TradingKey {
  const [vault, setVault] = useState<Vault | null>(null);
  /*
   * Every unlocked key, in vault order. The first is the primary: it is what
   * the single-wallet parts of the app act on, so nothing that existed before
   * multi-wallet has to know about the rest.
   */
  const [accounts, setAccounts] = useState<Account[]>([]);
  const account = accounts[0] ?? null;
  /*
   * The derived AES key, kept while unlocked so adding or removing a wallet
   * does not ask for the passphrase again. No weaker than what is already
   * held: the private keys themselves are in memory beside it.
   */
  const cryptoKeyRef = useRef<CryptoKey | null>(null);
  /*
   * The keys themselves, beside the accounts derived from them.
   *
   * A viem Account can sign but never hands the key back, and adding a wallet
   * means re-sealing the whole set — so the set has to be held. Same lifetime
   * as the accounts: gone on lock, on the idle timer, and on forget.
   */
  const keysRef = useRef<Hex[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockAt, setLockAt] = useState<number | null>(null);
  const [watching, setWatchingState] = useState(false);
  const window = watching ? WATCHING_LOCK_MS : IDLE_LOCK_MS;

  // localStorage is not available during render on the server.
  useEffect(() => setVault(readVault()), []);

  /** Push the idle deadline out. Called whenever the key is actually used. */
  const touch = useCallback(() => {
    setLockAt(Date.now() + window);
  }, [window]);

  /*
   * Arming a rule extends the deadline immediately rather than at the next
   * trade, or a wallet already thirteen minutes idle would lock two minutes
   * after the trader set a stop-loss.
   *
   * Idempotent, and that is load-bearing rather than tidiness. The caller is
   * an effect that re-runs on every render, and pushing the deadline to
   * Date.now() + window produces a different number each time — a state change
   * that causes the render that causes the state change. Unlocked wallets sat
   * in that loop. Nothing moves unless the answer actually flips.
   */
  const watchingRef = useRef(false);
  const setWatching = useCallback((on: boolean) => {
    if (watchingRef.current === on) return;
    watchingRef.current = on;
    setWatchingState(on);
    setLockAt((prev) =>
      prev == null ? prev : Date.now() + (on ? WATCHING_LOCK_MS : IDLE_LOCK_MS),
    );
  }, []);

  /*
   * Lock on inactivity, and on the tab being hidden for a long stretch.
   *
   * The timer is checked rather than scheduled once, because a laptop that
   * sleeps does not fire a pending setTimeout on time — the deadline is a
   * timestamp so a machine that wakes an hour later locks immediately.
   */
  useEffect(() => {
    if (!account || lockAt == null) return;
    const iv = setInterval(() => {
      if (Date.now() >= lockAt) {
        setAccounts([]);
        cryptoKeyRef.current = null;
    keysRef.current = [];
        setLockAt(null);
      }
    }, 10_000);
    return () => clearInterval(iv);
  }, [account, lockAt]);

  const store = useCallback(async (keys: Hex[], pass: string) => {
    const v = await makeVault(keys, pass);
    localStorage.setItem(STORE, JSON.stringify(v));
    cryptoKeyRef.current = await keyFrom(pass, unb64(v.salt));
    setVault(v);
    keysRef.current = keys;
    setAccounts(keys.map((k) => privateKeyToAccount(k)));
    setLockAt(Date.now() + IDLE_LOCK_MS);
    setWatchingState(false);
    watchingRef.current = false;
  }, []);

  /** Write a changed key set back, re-sealed with the key already in hand. */
  const save = useCallback(
    async (keys: Hex[]) => {
      const v = readVault();
      const ck = cryptoKeyRef.current;
      if (!v || !ck) throw new Error("Unlock first.");
      const next = await resealVault(v, ck, keys);
      localStorage.setItem(STORE, JSON.stringify(next));
      setVault(next);
      keysRef.current = keys;
      setAccounts(keys.map((k) => privateKeyToAccount(k)));
    },
    [],
  );

  const create = useCallback(
    async (pass: string) => {
      setBusy(true);
      setError(null);
      try {
        if (pass.length < 12) throw new Error("Use at least 12 characters.");
        await store([generatePrivateKey()], pass);
      } catch (e) {
        setError(e instanceof Error ? e.message : "could not create the key");
      } finally {
        setBusy(false);
      }
    },
    [store],
  );

  const importKey = useCallback(
    async (privateKey: string, pass: string) => {
      setBusy(true);
      setError(null);
      try {
        if (pass.length < 12) throw new Error("Use at least 12 characters.");
        await store([normalisePrivateKey(privateKey)], pass);
      } catch (e) {
        setError(e instanceof Error ? e.message : "could not import the key");
      } finally {
        setBusy(false);
      }
    },
    [store],
  );

  const unlock = useCallback(async (pass: string) => {
    const v = readVault();
    if (!v) return;
    setBusy(true);
    setError(null);
    try {
      const keys = await openVault(v, pass);
      cryptoKeyRef.current = await keyFrom(pass, unb64(v.salt));
      keysRef.current = keys;
      setAccounts(keys.map((k) => privateKeyToAccount(k)));
      setLockAt(Date.now() + IDLE_LOCK_MS);
      /*
       * A v1 vault is rewritten as v2 the first time it is opened, so the
       * migration happens once, silently, on a passphrase we have just
       * verified — rather than on some later write that might not have one.
       */
      if (v.v === 1) {
        const next = await resealVault(v, cryptoKeyRef.current, keys);
        localStorage.setItem(STORE, JSON.stringify(next));
        setVault(next);
      }
    } catch {
      // AES-GCM fails authentication on a wrong passphrase; there is no way
      // to tell that apart from corruption, and the honest message is the
      // one the user can act on.
      setError("Wrong passphrase.");
    } finally {
      setBusy(false);
    }
  }, []);

  const reveal = useCallback(async (pass: string): Promise<string | null> => {
    const v = readVault();
    if (!v) return null;
    try {
      // Newline-separated when there are several: one key per line is what a
      // person pastes into another wallet, one at a time.
      return (await openVault(v, pass)).join("\n");
    } catch {
      setError("Wrong passphrase.");
      return null;
    }
  }, []);

  /**
   * Add a wallet to an unlocked vault — generated, or imported from a key.
   *
   * Needs no passphrase: the derived key is already held, which is the whole
   * reason it is kept. Ordering matters, so a new wallet goes on the end and
   * the primary never changes underneath somebody mid-trade.
   */
  const addWallet = useCallback(
    async (privateKey?: string) => {
      setBusy(true);
      setError(null);
      try {
        if (!cryptoKeyRef.current) throw new Error("Unlock first.");
        const pk = privateKey ? normalisePrivateKey(privateKey) : generatePrivateKey();
        if (keysRef.current.includes(pk)) throw new Error("That wallet is already here.");
        await save([...keysRef.current, pk]);
      } catch (e) {
        setError(e instanceof Error ? e.message : "could not add a wallet");
      } finally {
        setBusy(false);
      }
    },
    [save],
  );

  /**
   * Drop a wallet from the vault.
   *
   * The key goes with it, and this browser is the only place it existed — so
   * anything still held by that address is unreachable afterwards. The caller
   * is responsible for saying so before calling; the balance check belongs
   * where the confirmation is, not here.
   */
  const removeWallet = useCallback(
    async (address: Address) => {
      setBusy(true);
      setError(null);
      try {
        if (!cryptoKeyRef.current) throw new Error("Unlock first.");
        const keys = keysRef.current.filter(
          (k) => privateKeyToAccount(k).address.toLowerCase() !== address.toLowerCase(),
        );
        // Emptying the vault is `forget`, which also clears the passphrase and
        // the stored blob. Silently leaving an empty vault behind is worse.
        if (!keys.length) throw new Error("That is the last wallet — use Forget instead.");
        if (keys.length === keysRef.current.length) throw new Error("No such wallet.");
        await save(keys);
      } catch (e) {
        setError(e instanceof Error ? e.message : "could not remove that wallet");
      } finally {
        setBusy(false);
      }
    },
    [save],
  );

  const lock = useCallback(() => {
    setAccounts([]);
    cryptoKeyRef.current = null;
    keysRef.current = [];
    setLockAt(null);
  }, []);

  const forget = useCallback(() => {
    localStorage.removeItem(STORE);
    setVault(null);
    setAccounts([]);
    cryptoKeyRef.current = null;
    keysRef.current = [];
    setLockAt(null);
  }, []);

  /*
   * Signs locally and broadcasts over plain HTTP — no injected provider, so
   * nothing to confirm. This is the whole speed difference.
   */
  const clients = accounts.map((a) =>
    createWalletClient({ account: a, chain: robinhoodChain, transport: broadcastTransport() }),
  );
  const client = clients[0] ?? null;

  return {
    exists: !!vault,
    lockingIn: account && lockAt != null ? Math.max(0, lockAt - Date.now()) : null,
    address: addressesOf(vault)[0] ?? null,
    addresses: addressesOf(vault),
    accounts,
    clients,
    addWallet,
    removeWallet,
    unlocked: !!account,
    busy,
    error,
    create,
    importKey,
    unlock,
    lock,
    reveal,
    forget,
    account,
    client,
    touch,
    setWatching,
  };
}
