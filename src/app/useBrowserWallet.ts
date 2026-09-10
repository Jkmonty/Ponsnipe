"use client";

/**
 * The visitor's own wallet, connected in their browser.
 *
 * This is what makes the hosted instance tradeable without anyone installing
 * anything and without this app ever holding a key. The bot wallet on a local
 * install still exists and still does the unattended selling; here the trader
 * signs every transaction themselves in MetaMask, Rabby or whatever else they
 * use.
 *
 * Deliberately viem and the raw EIP-1193 provider rather than wagmi or
 * RainbowKit. Those bring a connector registry, a React context, a query
 * client and a modal — a large dependency for one chain and one button, on a
 * page whose whole selling point is that it updates faster than the
 * competition.
 */
import { useCallback, useEffect, useState } from "react";
import { createWalletClient, custom, type Address, type WalletClient } from "viem";
import { robinhoodChain } from "@/lib/chain";

/** The subset of EIP-1193 this needs, so `any` never enters the file. */
interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

function provider(): Eip1193 | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { ethereum?: Eip1193 };
  return w.ethereum ?? null;
}

/** Chain id as the wallet wants it: hex, no leading zeroes. */
const CHAIN_HEX = `0x${robinhoodChain.id.toString(16)}`;

export interface BrowserWallet {
  /** Null until connected. */
  address: Address | null;
  chainId: number | null;
  onRightChain: boolean;
  /** False when no injected wallet is present at all. */
  available: boolean;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchChain: () => Promise<void>;
  /** Signs as the connected account. Null until connected. */
  client: WalletClient | null;
}

/**
 * Ask the wallet to move to Robinhood Chain, adding it if it has never heard
 * of it. Throws if the trader refuses; callers decide whether that matters.
 */
async function switchToChain(p: Eip1193): Promise<void> {
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  } catch (e) {
    // 4902 means the wallet has never heard of this chain, so offer it rather
    // than leaving the trader to type an RPC URL by hand.
    if ((e as { code?: number }).code !== 4902) throw e;
    await p.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: CHAIN_HEX,
          chainName: robinhoodChain.name,
          nativeCurrency: robinhoodChain.nativeCurrency,
          rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
          blockExplorerUrls: [robinhoodChain.blockExplorers.default.url],
        },
      ],
    });
  }
}

export function useBrowserWallet(): BrowserWallet {
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);

  // Read after mount: the server has no window, and deciding this during
  // render would make the first client paint disagree with the server's HTML.
  useEffect(() => setAvailable(!!provider()), []);

  const readChain = useCallback(async (p: Eip1193) => {
    try {
      const id = (await p.request({ method: "eth_chainId" })) as string;
      setChainId(Number.parseInt(id, 16));
    } catch {
      setChainId(null);
    }
  }, []);

  /*
   * Reconnect silently if the wallet already trusts this site.
   *
   * eth_accounts, not eth_requestAccounts: the first returns what is already
   * authorised and the second opens a popup. Asking on page load would put an
   * unprompted wallet dialog in front of everyone who opens the feed.
   */
  useEffect(() => {
    const p = provider();
    if (!p) return;
    void (async () => {
      try {
        const accs = (await p.request({ method: "eth_accounts" })) as string[];
        if (accs?.length) {
          setAddress(accs[0] as Address);
          await readChain(p);
        }
      } catch {
        /* not authorised yet, which is the normal case */
      }
    })();

    const onAccounts = (...args: unknown[]) => {
      const accs = args[0] as string[] | undefined;
      setAddress(accs?.length ? (accs[0] as Address) : null);
    };
    // A chain change invalidates every quote on screen, and wallets recommend
    // reloading rather than trying to reconcile it.
    const onChain = (...args: unknown[]) => {
      const id = args[0] as string | undefined;
      setChainId(id ? Number.parseInt(id, 16) : null);
    };
    p.on?.("accountsChanged", onAccounts);
    p.on?.("chainChanged", onChain);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
  }, [readChain]);

  const connect = useCallback(async () => {
    const p = provider();
    if (!p) {
      setError("No wallet found. Install MetaMask or Rabby, then reload.");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const accs = (await p.request({ method: "eth_requestAccounts" })) as string[];
      setAddress((accs?.[0] as Address) ?? null);
      /*
       * Put them on the right chain straight away rather than waiting for
       * something to go wrong.
       *
       * The switch logic existed and was behind a button nobody had a reason
       * to press, so connecting left the wallet on whatever network it was
       * already on — usually mainnet. Every send after that went to the wrong
       * chain while looking completely correct in the confirmation dialog,
       * because the address and the amount are right; only the ledger is not.
       *
       * Ignored if refused: the trader may have a reason, and the send path
       * checks the chain again anyway.
       */
      await switchToChain(p).catch(() => {});
      await readChain(p);
    } catch (e) {
      // 4001 is the user closing the popup, which is not an error worth
      // shouting about — they simply changed their mind.
      const code = (e as { code?: number }).code;
      setError(code === 4001 ? null : ((e as Error).message ?? "could not connect"));
    } finally {
      setConnecting(false);
    }
  }, [readChain]);

  /*
   * There is no way to make a wallet forget a site from here.
   *
   * EIP-1193 has no disconnect. This clears our state so the UI stops acting
   * connected, and the button says "forget" rather than "disconnect" so nobody
   * believes a permission was revoked that was not.
   */
  const disconnect = useCallback(() => {
    setAddress(null);
    setError(null);
  }, []);

  const switchChain = useCallback(async () => {
    const p = provider();
    if (!p) return;
    setError(null);
    try {
      await switchToChain(p);
    } catch (e) {
      setError((e as Error).message ?? "could not switch network");
    }
    await readChain(p);
  }, [readChain]);

  const p = provider();
  const client =
    address && p
      ? createWalletClient({ account: address, chain: robinhoodChain, transport: custom(p) })
      : null;

  return {
    address,
    chainId,
    onRightChain: chainId === robinhoodChain.id,
    available,
    connecting,
    error,
    connect,
    disconnect,
    switchChain,
    client,
  };
}
