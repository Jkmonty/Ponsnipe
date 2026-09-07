"use client";

/**
 * One wallet, shared by the bar at the top and the panel on the right.
 *
 * The trading key used to be created inside TradePanel, which meant the only
 * place a wallet could be connected was halfway down a sidebar — and the panel
 * had to become a signup form to do it, pushing the actual trading interface
 * off the screen for anyone who had not set one up yet.
 *
 * Lifting it here lets the button live where every other exchange puts it and
 * lets the panel go back to being a buy form. Both read the same hook, so the
 * balance in the header and the balance the buy is checked against cannot
 * disagree.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { browserPublic } from "./browserTrade";
import { useBrowserWallet, type BrowserWallet } from "./useBrowserWallet";
import { useTradingKey, type TradingKey } from "./useTradingKey";
import { DEFAULT_LIMITS, readLimits, readSpentToday, writeLimits, type Limits } from "./limits";

interface WalletCtx {
  /** The browser-held trading key that signs without prompting. */
  key: TradingKey;
  /** MetaMask, Rabby and friends — used only to fund and to empty. */
  ext: BrowserWallet;
  /** Trading-key ETH balance, or null when it could not be read. */
  bal: bigint | null;
  refreshBal: () => Promise<void>;
  limits: Limits;
  setLimits: (l: Limits) => void;
  spent: number;
  /** Re-read today's spend after a buy. */
  syncSpent: () => void;
  /** Whether the wallet menu under the header button is open. */
  menu: boolean;
  setMenu: (open: boolean) => void;
  /** Open the menu from anywhere — the panel's own "connect" prompt uses it. */
  openMenu: () => void;
}

const Ctx = createContext<WalletCtx | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const key = useTradingKey();
  const ext = useBrowserWallet();
  const [bal, setBal] = useState<bigint | null>(null);
  const [limits, setLimitsState] = useState<Limits>(DEFAULT_LIMITS);
  const [spent, setSpent] = useState(0);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    setLimitsState(readLimits());
    setSpent(readSpentToday());
  }, []);

  const address = key.address;
  const refreshBal = useCallback(async () => {
    if (!address) return setBal(null);
    try {
      setBal(await browserPublic().getBalance({ address }));
    } catch {
      // Null, not zero. "Could not read the balance" and "the wallet is empty"
      // look identical if both render as 0, and only one of them means the
      // trader needs to send funds.
      setBal(null);
    }
  }, [address]);

  useEffect(() => {
    void refreshBal();
  }, [refreshBal]);

  const setLimits = useCallback((l: Limits) => {
    setLimitsState(l);
    writeLimits(l);
  }, []);

  return (
    <Ctx.Provider
      value={{
        key,
        ext,
        bal,
        refreshBal,
        limits,
        setLimits,
        spent,
        syncSpent: useCallback(() => setSpent(readSpentToday()), []),
        menu,
        setMenu,
        openMenu: useCallback(() => setMenu(true), []),
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useWallet(): WalletCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useWallet outside WalletProvider");
  return c;
}
