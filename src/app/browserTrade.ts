"use client";

/**
 * Chain reads and trade building, from the browser.
 *
 * Separate from src/lib/chain.ts on purpose: that module reads server-only
 * environment variables and is wired to the bot wallet, neither of which
 * exists in a tab. This talks to the public endpoints directly.
 *
 * Endpoint order is measured, not assumed. Of the four public RPCs, arrowrpc
 * sends no CORS headers and a browser cannot reach it at all; the rest
 * answered a browser in 92ms, 299ms and 332ms, so publicnode leads.
 */
import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  parseAbi,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { robinhoodChain } from "@/lib/chain";
import { bondingCurveAbi, erc20Abi } from "@/lib/pons/abis";
import { applySlippage, quoteBuy, type CurveReserves } from "@/lib/pons/pricing";

const RPCS = [
  "https://robinhood-rpc.publicnode.com",
  "https://rpc.mainnet.chain.robinhood.com",
  "https://rpc.ordofi.network",
];

/** Uniswap V3 pieces, duplicated here so the browser bundle carries no server code. */
const V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as Address;
const SWAP_ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2" as Address;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;
const FEE_TIERS = [500, 3000, 10000] as const;
const ZERO = "0x0000000000000000000000000000000000000000";

const v3FactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);
export const swapRouterAbi = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);

let cached: PublicClient | null = null;
export function browserPublic(): PublicClient {
  if (cached) return cached;
  cached = createPublicClient({
    chain: robinhoodChain,
    transport: fallback(
      RPCS.map((u) => http(u, { retryCount: 1, timeout: 12_000 })),
      { retryCount: 0 },
    ),
  }) as PublicClient;
  return cached;
}

export interface ZapRoute {
  fee: number;
  wethDepth: bigint;
}

const routes = new Map<string, ZapRoute | null>();

/** Deepest WETH pool for a quote asset — deepest, not cheapest-fee. */
export async function findRoute(quote: Address): Promise<ZapRoute | null> {
  const key = quote.toLowerCase();
  const hit = routes.get(key);
  if (hit !== undefined) return hit;
  const c = browserPublic();
  let best: ZapRoute | null = null;
  for (const fee of FEE_TIERS) {
    try {
      const pool = (await c.readContract({
        address: V3_FACTORY,
        abi: v3FactoryAbi,
        functionName: "getPool",
        args: [WETH, quote, fee],
      })) as Address;
      if (!pool || pool === ZERO) continue;
      const depth = (await c.readContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [pool],
      })) as bigint;
      if (depth > 0n && (!best || depth > best.wethDepth)) best = { fee, wethDepth: depth };
    } catch {
      /* no pool at this tier */
    }
  }
  routes.set(key, best);
  return best;
}

/**
 * What a swap would return, asked of the router.
 *
 * This chain's eth_call checks that a payable sender can cover value plus gas,
 * so the caller is funded by a state override for the duration of the call.
 * Nothing is written and nothing is spent.
 */
export async function quoteZap(
  quote: Address,
  ethIn: bigint,
  from: Address,
): Promise<{ out: bigint; route: ZapRoute } | null> {
  if (ethIn <= 0n) return null;
  const route = await findRoute(quote);
  if (!route) return null;
  try {
    const { result } = await browserPublic().simulateContract({
      account: from,
      address: SWAP_ROUTER,
      abi: swapRouterAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: WETH,
          tokenOut: quote,
          fee: route.fee,
          recipient: from,
          amountIn: ethIn,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
      value: ethIn,
      stateOverride: [{ address: from, balance: 1_000n * 10n ** 18n }],
    });
    return { out: result as bigint, route };
  } catch {
    return null;
  }
}

export interface BuyPlan {
  curve: Address;
  token: Address;
  pairToken: Address;
  quoteIsNative: boolean;
  reserves: CurveReserves;
  feeBps: number;
  creatorTaxBps: number;
  slippageBps: number;
}

/**
 * Buy a coin, swapping into its quote asset first when it does not take ETH.
 *
 * Returns every hash it sent, because a non-ETH purchase is up to three
 * transactions and a trader who has just spent money needs to be able to
 * follow all of them, not only the last.
 */
export async function executeBuy(
  wallet: WalletClient,
  account: Address,
  ethIn: bigint,
  p: BuyPlan,
): Promise<{ hashes: `0x${string}`[]; spentQuote: bigint }> {
  const c = browserPublic();
  const hashes: `0x${string}`[] = [];

  let quoteIn = ethIn;

  if (!p.quoteIsNative) {
    const quote = getAddress(p.pairToken);
    const expected = await quoteZap(quote, ethIn, account);
    if (!expected) throw new Error("no route from ETH into this coin's currency");

    const before = (await c.readContract({
      address: quote,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
    })) as bigint;

    const swapHash = await wallet.writeContract({
      account,
      chain: robinhoodChain,
      address: SWAP_ROUTER,
      abi: swapRouterAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: WETH,
          tokenOut: quote,
          fee: expected.route.fee,
          recipient: account,
          amountIn: ethIn,
          amountOutMinimum: applySlippage(expected.out, p.slippageBps),
          sqrtPriceLimitX96: 0n,
        },
      ],
      value: ethIn,
    });
    hashes.push(swapHash);
    const r = await c.waitForTransactionReceipt({ hash: swapHash });
    if (r.status !== "success") throw new Error("the swap into the coin's currency failed");

    const after = (await c.readContract({
      address: quote,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
    })) as bigint;
    // Size the curve buy from what actually arrived, never from the estimate:
    // asking the curve for more than we hold reverts the whole thing.
    quoteIn = after > before ? after - before : 0n;
    if (quoteIn <= 0n) throw new Error("the swap delivered nothing");

    const allowance = (await c.readContract({
      address: quote,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account, p.curve],
    })) as bigint;
    if (allowance < quoteIn) {
      const ap = await wallet.writeContract({
        account,
        chain: robinhoodChain,
        address: quote,
        abi: erc20Abi,
        functionName: "approve",
        args: [p.curve, quoteIn],
      });
      hashes.push(ap);
      await c.waitForTransactionReceipt({ hash: ap });
    }
  }

  const q = quoteBuy(quoteIn, p.reserves, BigInt(p.feeBps), BigInt(p.creatorTaxBps));
  const minOut = applySlippage(q.tokensOut, p.slippageBps);
  if (minOut <= 0n) throw new Error("slippage leaves no minimum — raise the amount");

  const buyHash = await wallet.writeContract({
    account,
    chain: robinhoodChain,
    address: p.curve,
    abi: bondingCurveAbi,
    functionName: "buy",
    args: [quoteIn, minOut, account],
    value: p.quoteIsNative ? quoteIn : 0n,
  });
  hashes.push(buyHash);
  const rec = await c.waitForTransactionReceipt({ hash: buyHash });
  if (rec.status !== "success") throw new Error("the buy reverted");
  return { hashes, spentQuote: quoteIn };
}
