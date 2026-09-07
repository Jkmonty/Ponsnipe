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
import { useCallback, useEffect, useState } from "react";
import {
  createWalletClient,
  http,
  type Account,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { robinhoodChain } from "@/lib/chain";

const STORE = "ponsnipe.tradingKey.v1";

/**
 * Broadcast endpoint, chosen by measurement rather than by name.
 *
 * Of the four public endpoints, one refuses browser requests outright (no CORS
 * headers) and the rest answered a browser in 92ms, 299ms and 332ms. The
 * fastest is used first and the others follow it, because the whole reason
 * this key exists is to remove seconds from a buy.
 */
const RPCS = [
  "https://robinhood-rpc.publicnode.com",
  "https://rpc.mainnet.chain.robinhood.com",
  "https://rpc.ordofi.network",
];

interface Vault {
  v: 1;
  salt: string;
  iv: string;
  data: string;
  address: Address;
}

const b64 = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * PBKDF2 at 310,000 rounds, which is the OWASP figure for SHA-256 and takes
 * roughly a fifth of a second here. It is paid once per session on unlock, not
 * per trade, so it does not touch the speed this whole file exists for.
 */
async function keyFrom(pass: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 310_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

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
  /** Address of the stored key, known even while locked. */
  address: Address | null;
  /** Unlocked and ready to sign without prompting. */
  unlocked: boolean;
  busy: boolean;
  error: string | null;
  create: (pass: string) => Promise<void>;
  importKey: (privateKey: string, pass: string) => Promise<void>;
  unlock: (pass: string) => Promise<void>;
  lock: () => void;
  /** The raw key, for backing up or sweeping into another wallet. */
  reveal: (pass: string) => Promise<string | null>;
  forget: () => void;
  account: Account | null;
  client: WalletClient | null;
}

export function useTradingKey(): TradingKey {
  const [vault, setVault] = useState<Vault | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // localStorage is not available during render on the server.
  useEffect(() => setVault(readVault()), []);

  const store = useCallback(async (pk: Hex, pass: string) => {
    const acct = privateKeyToAccount(pk);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await keyFrom(pass, salt);
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode(pk),
    );
    const v: Vault = { v: 1, salt: b64(salt), iv: b64(iv), data: b64(data), address: acct.address };
    localStorage.setItem(STORE, JSON.stringify(v));
    setVault(v);
    setAccount(acct);
  }, []);

  const create = useCallback(
    async (pass: string) => {
      setBusy(true);
      setError(null);
      try {
        if (pass.length < 8) throw new Error("Use at least 8 characters.");
        await store(generatePrivateKey(), pass);
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
        if (pass.length < 8) throw new Error("Use at least 8 characters.");
        const pk = privateKey.trim().startsWith("0x") ? privateKey.trim() : `0x${privateKey.trim()}`;
        if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("That is not a private key.");
        await store(pk as Hex, pass);
      } catch (e) {
        setError(e instanceof Error ? e.message : "could not import the key");
      } finally {
        setBusy(false);
      }
    },
    [store],
  );

  const decrypt = useCallback(async (v: Vault, pass: string): Promise<Hex> => {
    const key = await keyFrom(pass, unb64(v.salt));
    const out = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(v.iv) as BufferSource },
      key,
      unb64(v.data) as BufferSource,
    );
    return new TextDecoder().decode(out) as Hex;
  }, []);

  const unlock = useCallback(
    async (pass: string) => {
      const v = readVault();
      if (!v) return;
      setBusy(true);
      setError(null);
      try {
        setAccount(privateKeyToAccount(await decrypt(v, pass)));
      } catch {
        // AES-GCM fails authentication on a wrong passphrase; there is no way
        // to tell that apart from corruption, and the honest message is the
        // one the user can act on.
        setError("Wrong passphrase.");
      } finally {
        setBusy(false);
      }
    },
    [decrypt],
  );

  const reveal = useCallback(
    async (pass: string): Promise<string | null> => {
      const v = readVault();
      if (!v) return null;
      try {
        return await decrypt(v, pass);
      } catch {
        setError("Wrong passphrase.");
        return null;
      }
    },
    [decrypt],
  );

  const lock = useCallback(() => setAccount(null), []);

  const forget = useCallback(() => {
    localStorage.removeItem(STORE);
    setVault(null);
    setAccount(null);
  }, []);

  /*
   * Signs locally and broadcasts over plain HTTP — no injected provider, so
   * nothing to confirm. This is the whole speed difference.
   */
  const client = account
    ? createWalletClient({
        account,
        chain: robinhoodChain,
        transport: http(RPCS[0], { retryCount: 2, timeout: 15_000 }),
      })
    : null;

  return {
    exists: !!vault,
    address: vault?.address ?? null,
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
  };
}
