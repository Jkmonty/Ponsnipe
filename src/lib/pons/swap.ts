import {
  getAddress,
  maxUint256,
  parseEventLogs,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { env } from "../env";
import { publicClient } from "../chain";
import { botWallet } from "../wallet/botWallet";
import { NATIVE_QUOTE } from "./addresses";
import { erc20Abi, bondingCurveAbi } from "./abis";
import {
  quoteBuy,
  quoteSell,
  applySlippage,
  type CurveReserves,
} from "./pricing";

export interface SwapResult {
  hash: Hex;
  /** Net change in the received asset, smallest units. */
  filled: bigint;
  gasUsed: bigint;
  effectivePrice: number;
}

interface CurveCtx {
  curve: Address;
  token: Address;
  pairToken: Address;
  tokenDecimals: number;
  quoteDecimals: number;
  feeBps: number;
  creatorTaxBps: number;
  reserves: CurveReserves;
  slippageBps?: number;
}

type FeeOverride =
  | { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | { gasPrice: bigint }
  | Record<string, never>;

/** Estimate fees and multiply the priority tip so an auto-sell wins its block. */
async function bumpedFees(c: ReturnType<typeof publicClient>): Promise<FeeOverride> {
  const mult = env.sellGasMultiplier;
  try {
    const f = await c.estimateFeesPerGas();
    if (f.maxPriorityFeePerGas != null && f.maxFeePerGas != null) {
      const tip = (f.maxPriorityFeePerGas * BigInt(Math.round(mult * 100))) / 100n;
      const base = f.maxFeePerGas - f.maxPriorityFeePerGas;
      return { maxPriorityFeePerGas: tip, maxFeePerGas: base + tip };
    }
  } catch {
    /* fall through to legacy */
  }
  try {
    const gp = await c.getGasPrice();
    return { gasPrice: (gp * BigInt(Math.round(mult * 100))) / 100n };
  } catch {
    return {};
  }
}

/**
 * Read the exact fill out of the curve's own event in this receipt.
 *
 * Balance-diffing the wallet is not safe here: the sniper and the monitor share
 * one wallet, so an ETH-spending buy landing between the before/after reads
 * would be silently attributed to this sell and corrupt the recorded PnL.
 */
function filledFromReceipt(
  receipt: TransactionReceipt,
  curve: Address,
  recipient: Address,
  which: "CurveBuy" | "CurveSell",
): bigint | null {
  try {
    const events = parseEventLogs({
      abi: bondingCurveAbi,
      eventName: which,
      logs: receipt.logs,
    });
    const curveLc = curve.toLowerCase();
    const recLc = recipient.toLowerCase();
    for (const e of events) {
      if (e.address.toLowerCase() !== curveLc) continue;
      const args = e.args as unknown as {
        recipient?: string;
        tokensOut?: bigint;
        quoteOut?: bigint;
      };
      if (args.recipient?.toLowerCase() !== recLc) continue;
      const v = which === "CurveBuy" ? args.tokensOut : args.quoteOut;
      if (typeof v === "bigint") return v;
    }
  } catch {
    /* fall back to the balance diff */
  }
  return null;
}

async function ensureAllowance(token: Address, spender: Address, need: bigint) {
  const { account, wallet } = botWallet();
  const c = publicClient();
  const cur = await c.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, spender],
  });
  if (cur >= need) return;
  const hash = await wallet.writeContract({
    account,
    chain: wallet.chain,
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, maxUint256],
  });
  const r = await c.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`approve() reverted: ${hash}`);
}

/** Buy `token` from its bonding curve, spending `quoteInWei` of the quote asset. */
export async function buyOnCurve(p: CurveCtx & { quoteInWei: bigint }): Promise<SwapResult> {
  const { account, wallet } = botWallet();
  const c = publicClient();
  const slippageBps = p.slippageBps ?? env.defaultSlippageBps;
  const native = getAddress(p.pairToken) === NATIVE_QUOTE;

  const q = quoteBuy(p.quoteInWei, p.reserves, BigInt(p.feeBps), BigInt(p.creatorTaxBps));
  const minTokensOut = applySlippage(q.tokensOut, slippageBps);
  if (minTokensOut <= 0n) throw new Error("quote produced zero tokens — curve too thin or bad price");

  if (!native) {
    await ensureAllowance(getAddress(p.pairToken), p.curve, p.quoteInWei);
  }

  const balBefore = await c.readContract({
    address: p.token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });

  const feeOverride = await bumpedFees(c);

  const hash = await wallet.writeContract({
    account,
    chain: wallet.chain,
    address: p.curve,
    abi: bondingCurveAbi,
    functionName: "buy",
    args: [p.quoteInWei, minTokensOut, account.address],
    value: native ? p.quoteInWei : 0n,
    ...feeOverride,
  });
  const receipt = await c.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`buy reverted: ${hash}`);

  let filled = filledFromReceipt(receipt, p.curve, account.address, "CurveBuy");
  if (filled == null) {
    const balAfter = await c.readContract({
      address: p.token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    filled = balAfter - balBefore;
  }
  const effectivePrice =
    filled > 0n
      ? Number(p.quoteInWei) / 10 ** p.quoteDecimals / (Number(filled) / 10 ** p.tokenDecimals)
      : 0;
  return { hash, filled, gasUsed: receipt.gasUsed, effectivePrice };
}

/** Sell `tokensInWei` of `token` back to its bonding curve for the quote asset. */
export async function sellOnCurve(p: CurveCtx & { tokensInWei: bigint }): Promise<SwapResult> {
  const { account, wallet } = botWallet();
  const c = publicClient();
  const slippageBps = p.slippageBps ?? env.defaultSlippageBps;
  const native = getAddress(p.pairToken) === NATIVE_QUOTE;

  await ensureAllowance(p.token, p.curve, p.tokensInWei);

  const q = quoteSell(p.tokensInWei, p.reserves, BigInt(p.feeBps), BigInt(p.creatorTaxBps));
  const minQuoteOut = applySlippage(q.quoteOut, slippageBps);
  if (minQuoteOut <= 0n) throw new Error("quote produced zero proceeds — curve too thin");

  // Both are pre-send reads on the critical path of an auto-sell — run them
  // together rather than back to back. (The balance is only a fallback for
  // filledFromReceipt; the fee bump makes the sell win its block.)
  const [quoteBalBefore, feeOverride] = await Promise.all([
    native
      ? c.getBalance({ address: account.address })
      : (c.readContract({
          address: getAddress(p.pairToken),
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account.address],
        }) as Promise<bigint>),
    bumpedFees(c),
  ]);

  const hash = await wallet.writeContract({
    account,
    chain: wallet.chain,
    address: p.curve,
    abi: bondingCurveAbi,
    functionName: "sell",
    args: [p.tokensInWei, minQuoteOut, account.address],
    ...feeOverride,
  });
  const receipt = await c.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`sell reverted: ${hash}`);

  let filled = filledFromReceipt(receipt, p.curve, account.address, "CurveSell");
  if (filled == null) {
    // Fallback only — see filledFromReceipt for why this is the weaker path.
    if (native) {
      const after = await c.getBalance({ address: account.address });
      const gasCost = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
      filled = after - quoteBalBefore + gasCost; // proceeds before gas
    } else {
      const after = (await c.readContract({
        address: getAddress(p.pairToken),
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address],
      })) as bigint;
      filled = after - quoteBalBefore;
    }
  }

  const effectivePrice =
    p.tokensInWei > 0n
      ? Number(filled) / 10 ** p.quoteDecimals / (Number(p.tokensInWei) / 10 ** p.tokenDecimals)
      : 0;
  return { hash, filled, gasUsed: receipt.gasUsed, effectivePrice };
}
