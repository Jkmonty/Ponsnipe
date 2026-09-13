import { formatEther, type Address } from "viem";
import { readClient } from "./chain";

/**
 * The prize pool is the fee wallet's balance.
 *
 * A competition funded by a number on a website is a promise; one funded by
 * an address is a fact. So the pool is never a figure typed somewhere — it is
 * read from the chain, and the address is shown beside it so anybody can
 * check both.
 *
 * NEXT_PUBLIC_ because the browser sends the fee (see src/app/fee.ts); the
 * server reads the same variable, and applies the same shape test rather than
 * a checksum, so the two can never disagree about whether a wallet is set.
 */
export function feeWalletAddress(
  raw: string | undefined = process.env.NEXT_PUBLIC_FEE_WALLET,
): Address | null {
  const t = (raw ?? "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(t) ? (t as Address) : null;
}

export interface PoolInfo {
  wallet: Address;
  /** Balance in ETH. */
  eth: number;
}

/** Three decimals: enough to see a fee land, not enough to look like noise. */
export function fmtPool(eth: number): string {
  return `${eth.toFixed(3)} ETH`;
}

const TTL_MS = 60_000;
const g = globalThis as typeof globalThis & {
  __ponsPool?: { at: number; data: PoolInfo | null };
};

/**
 * The pool right now, or null when there is no fee wallet or the read fails.
 *
 * Cached for a minute in module scope. The landing page is force-dynamic, and
 * one balance read per request would otherwise be one RPC call per visitor.
 */
export async function poolBalance(): Promise<PoolInfo | null> {
  const wallet = feeWalletAddress();
  if (!wallet) return null;
  const hit = g.__ponsPool;
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  try {
    const wei = await readClient().getBalance({ address: wallet });
    const data = { wallet, eth: Number(formatEther(wei)) };
    g.__ponsPool = { at: Date.now(), data };
    return data;
  } catch {
    // A failed read is not a zero pool. Keep whatever was last known, and
    // remember the failure for the TTL so an RPC outage costs one read a
    // minute rather than one per visitor.
    const data = hit?.data ?? null;
    g.__ponsPool = { at: Date.now(), data };
    return data;
  }
}
