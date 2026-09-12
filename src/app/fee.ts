"use client";

/**
 * The trading fee, and the prize pool it fills.
 *
 * A percentage of each buy goes to one address. Nothing clever: it is the
 * arrangement every terminal in this market runs on, at roughly the rate they
 * all charge, and it exists so the weekly competition has something to pay out
 * that is not somebody's savings.
 *
 * What is unusual is that the pool is visible. The fee address is a normal
 * wallet on a public chain, so its balance is the prize pool and anybody can
 * check it — including whether it has been paid out. A competition funded by a
 * number on a website is a promise; one funded by an address is a fact.
 *
 * Two deliberate choices about where it sits in the buy.
 *
 * It comes out of the amount, not on top of it. Type 0.01 and 0.01 leaves the
 * wallet — a fee that quietly makes the number bigger is how people discover
 * they were charged.
 *
 * And it is sent *after* the coin is bought, not before. This is a sniper: the
 * buy is racing other bots and must not wait on an unrelated transfer. The fee
 * settles a moment later, out of the same wallet, once the thing being raced
 * for is already won.
 */
import { parseUnits, type Account, type Address, type WalletClient } from "viem";
import { robinhoodChain } from "@/lib/chain";

/**
 * Where fees go. Empty disables the fee entirely, which is the default and the
 * state every local install runs in.
 *
 * NEXT_PUBLIC_ because the browser sends it — the server never touches a key
 * and so cannot take a fee on anybody's behalf.
 */
export const FEE_WALLET = (process.env.NEXT_PUBLIC_FEE_WALLET ?? "").trim() as Address | "";

/**
 * One percent, the going rate. BONKbot charges 1%, AveSniper 0.8%,
 * ReaperSniper 0.7% — this sits at the top of that band rather than under it,
 * because undercutting on a fee nobody comparison-shops buys nothing.
 */
export const FEE_BPS = Math.max(
  0,
  Math.min(300, Number(process.env.NEXT_PUBLIC_FEE_BPS ?? 100) || 0),
);

export const feeEnabled = (): boolean => FEE_BPS > 0 && /^0x[0-9a-fA-F]{40}$/.test(FEE_WALLET);

/** The fee on a spend, and what is left to trade with. */
export function splitFee(ethIn: bigint): { fee: bigint; net: bigint } {
  if (!feeEnabled()) return { fee: 0n, net: ethIn };
  const fee = (ethIn * BigInt(FEE_BPS)) / 10_000n;
  return { fee, net: ethIn - fee };
}

/** The fee as a percentage, for saying so on screen. */
export const feePct = (): number => FEE_BPS / 100;

/**
 * Send the fee. Never throws, and never blocks the caller.
 *
 * A failed fee must not look like a failed trade. The coin is already bought
 * by the time this runs, so the worst case is a fee that did not collect —
 * which is our problem, not the trader's, and is not worth showing them an
 * error over.
 */
export function payFee(wallet: WalletClient, signer: Account, fee: bigint): void {
  if (fee <= 0n || !feeEnabled()) return;
  void wallet
    .sendTransaction({
      account: signer,
      chain: robinhoodChain,
      to: FEE_WALLET as Address,
      value: fee,
    })
    .catch(() => {});
}

/** Smallest fee worth a transaction: below this the gas costs more than it. */
export const DUST = parseUnits("0.000002", 18);
