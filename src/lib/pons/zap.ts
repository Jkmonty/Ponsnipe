/**
 * ETH into a curve's quote asset, so the other half of pons is reachable.
 *
 * About half of all pons launches are not quoted in ETH. Measured on the live
 * feed: 122 of 250 rows were ETH, the rest USDG, NVDA, AAPL, TSLA, SPY and
 * other tokenised equities. The sniper rejected every one of them with "pairs
 * against X, not ETH" — not because they were bad, but because the bot only
 * held ETH and a curve quoted in USDG will only take USDG.
 *
 * buyOnCurve already handles an ERC-20 quote: it approves the curve and sends
 * value 0. The only thing missing was holding the asset, which is what this
 * does.
 *
 * The route is Uniswap V3, not V4. The chain's V3 pools are deep — measured
 * WETH depth of 877 in USDG/500, 295 in SPY/500, 223 in NVDA/500 — and V3 has
 * a plain router that can be called directly, where V4's singleton needs an
 * unlock callback from a contract we would have to deploy. For the amounts
 * this bot trades, a 0.01 ETH swap against an 877 WETH pool is a rounding
 * error of price impact, so the simpler venue is also the better one.
 */
import { getAddress, parseAbi, type Address, type Hex } from "viem";
import { readClient } from "../chain";
import { botWallet } from "../wallet/botWallet";
import { PONS } from "./addresses";
import { erc20Abi } from "./abis";

/**
 * SwapRouter02, confirmed by selector against the deployed bytecode: it has
 * exactInputSingle at 04e45aaf (no deadline field) rather than the original
 * router's 414bf389, plus refundETH, multicall and unwrapWETH9. Its WETH9()
 * returns the same address addresses.ts already had.
 */
export const swapRouterAbi = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);

const v3FactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);

/** The fee tiers worth trying, cheapest first. */
const FEE_TIERS = [500, 3000, 10000] as const;

const ZERO = "0x0000000000000000000000000000000000000000";

export interface ZapRoute {
  pool: Address;
  fee: number;
  /** WETH held by the pool, as a plain depth measure. */
  wethDepth: bigint;
}

/**
 * Pick the deepest WETH pool for a quote asset.
 *
 * Deepest rather than cheapest-fee: a 500 tier that nobody has provided
 * liquidity to costs far more in price impact than a 3000 tier that is real,
 * and several of these assets have an empty tier sitting next to a full one —
 * NVDA has 223 WETH at 500 and nothing at all at 10000.
 *
 * Cached per quote asset, since pools do not move and this is on the path of
 * a trade that is trying to be fast.
 */
const routeCache = new Map<string, ZapRoute | null>();

export async function findRoute(quote: Address): Promise<ZapRoute | null> {
  const key = quote.toLowerCase();
  const hit = routeCache.get(key);
  if (hit !== undefined) return hit;

  const c = readClient();
  let best: ZapRoute | null = null;
  for (const fee of FEE_TIERS) {
    try {
      const pool = (await c.readContract({
        address: PONS.v3Factory,
        abi: v3FactoryAbi,
        functionName: "getPool",
        args: [PONS.weth, quote, fee],
      })) as Address;
      if (!pool || pool === ZERO) continue;
      const depth = (await c.readContract({
        address: PONS.weth,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [pool],
      })) as bigint;
      if (depth === 0n) continue;
      if (!best || depth > best.wethDepth) best = { pool, fee, wethDepth: depth };
    } catch {
      /* no pool at this tier */
    }
  }
  routeCache.set(key, best);
  return best;
}

/**
 * A stand-in caller for quoting.
 *
 * Quoting must not need the bot's key. The feed wants to say whether a
 * USDG-quoted coin is reachable, and the sniper wants to price the hop before
 * deciding — neither is spending anything, and requiring an unlocked keystore
 * to answer a read-only question would mean the app could not show it at all
 * until the wallet was set up.
 */
const QUOTE_CALLER = "0x000000000000000000000000000000000000dEaD" as Address;

/**
 * Balance handed to the caller for the duration of the call.
 *
 * This chain's eth_call DOES check that the sender can cover value plus gas,
 * so a payable swap cannot be simulated from an unfunded address — every quote
 * came back "total cost exceeds the balance of the account", including from
 * the bot's own empty wallet. A state override funds the caller inside the
 * call only; nothing is transferred and no state is written.
 */
const QUOTE_BALANCE = 1_000n * 10n ** 18n;

/**
 * What this swap would return, asked of the router itself.
 *
 * A simulate rather than a Quoter contract: SwapRouter02's exactInputSingle
 * returns amountOut, so simulating the real call gives the real number without
 * needing a QuoterV2 deployment we have not located on this chain, and without
 * the quote and the execution being two different code paths that can disagree.
 */
export async function quoteZap(
  quote: Address,
  ethIn: bigint,
  from?: Address,
): Promise<{ out: bigint; route: ZapRoute } | null> {
  if (ethIn <= 0n) return null;
  const route = await findRoute(quote);
  if (!route) return null;
  const caller = from ?? QUOTE_CALLER;
  try {
    const { result } = await readClient().simulateContract({
      account: caller,
      address: PONS.swapRouter,
      abi: swapRouterAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: PONS.weth,
          tokenOut: quote,
          fee: route.fee,
          recipient: caller,
          amountIn: ethIn,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
      value: ethIn,
      stateOverride: [{ address: caller, balance: QUOTE_BALANCE }],
    });
    return { out: result as bigint, route };
  } catch (err) {
    /*
     * A revert here is a real answer — the pool cannot fill this size — and
     * null is the right response. Anything else is our bug, and swallowing it
     * is how an invalid checksum in the caller constant above showed up as
     * "no route" for every single asset instead of as an error.
     */
    const msg = err instanceof Error ? err.message : String(err);
    if (/invalid address|is invalid|Version: viem/i.test(msg) && !/revert/i.test(msg)) {
      throw err;
    }
    return null;
  }
}

/**
 * What an amount of a quote asset is worth in ETH.
 *
 * Needed because the sniper's liquidity band is written in ETH while a curve's
 * reserve is denominated in whatever that curve trades against. Before the zap
 * existed the two were always the same asset so the comparison was safe; the
 * moment non-ETH launches became buyable it started comparing NVDA to ETH and
 * calling the answer "ETH". A curve holding 100 USDG was being read as 100 ETH
 * and waved past a 0.05 floor it should have been measured against properly.
 *
 * Priced off the same pool the zap would trade through, so the number the
 * filter judges is the number a real swap would produce. Returns null when the
 * asset has no route, which is the honest answer — an unreachable curve should
 * not be given a liquidity figure at all.
 */
export async function quoteAmountInEth(quote: Address, amountRaw: bigint): Promise<bigint | null> {
  if (amountRaw <= 0n) return 0n;
  const perEth = await quoteZap(quote, 10n ** 18n);
  if (!perEth || perEth.out <= 0n) return null;
  // amount / (quote per 1 ETH), kept in wei.
  return (amountRaw * 10n ** 18n) / perEth.out;
}

/** How much of `quote` the bot is holding right now. */
export async function quoteBalance(quote: Address): Promise<bigint> {
  const { account } = botWallet();
  return (await readClient().readContract({
    address: quote,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;
}

/**
 * The floor to accept on a zap, given a quote and a slippage budget.
 *
 * Pulled out as its own function so it can be tested without a chain. It is
 * the number that decides whether a swap that came back worse than expected
 * is accepted or reverted, which makes it the one piece of arithmetic here
 * that can silently cost money.
 */
export function zapMinOut(expectedOut: bigint, slippageBps: number): bigint {
  if (expectedOut <= 0n) return 0n;
  // Clamped rather than trusted: a negative budget would raise the floor above
  // the quote and reject every swap, and one over 100% would drop it to zero
  // and accept anything at all, which is the more expensive mistake.
  const bps = Math.max(0, Math.min(10_000, Math.round(slippageBps)));
  return (expectedOut * BigInt(10_000 - bps)) / 10_000n;
}

export interface ZapResult {
  hash: Hex;
  /** Quote asset actually received, from the balance delta. */
  received: bigint;
  route: ZapRoute;
}

/**
 * Swap native ETH for `quote`.
 *
 * Native in, not WETH: SwapRouter02 wraps for us when tokenIn is its own
 * WETH9 and the call carries value, so the bot never has to hold WETH or pay
 * for a separate deposit.
 *
 * `received` comes from the balance either side of the swap rather than the
 * router's return value, for the same reason buyOnCurve measures its own fill:
 * a fee-on-transfer quote asset would hand back less than the router reports,
 * and every downstream number is derived from this one.
 */
export async function zapEthToQuote(
  quote: Address,
  ethIn: bigint,
  slippageBps: number,
): Promise<ZapResult> {
  const q = getAddress(quote);
  const { account, wallet } = botWallet();
  // Quote as the wallet that will actually send it, so any caller-specific
  // revert shows up here rather than on the real transaction.
  const expected = await quoteZap(q, ethIn, account.address);
  if (!expected) throw new Error(`no Uniswap V3 route from ETH to ${q}`);

  const minOut = zapMinOut(expected.out, slippageBps);
  if (minOut <= 0n) throw new Error("zap quote produced zero output");

  const c = readClient();
  const before = await quoteBalance(q);

  const hash = await wallet.writeContract({
    account,
    chain: wallet.chain,
    address: PONS.swapRouter,
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: PONS.weth,
        tokenOut: q,
        fee: expected.route.fee,
        recipient: account.address,
        amountIn: ethIn,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      },
    ],
    value: ethIn,
  });

  const r = await c.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`zap swap reverted: ${hash}`);

  const after = await quoteBalance(q);
  const received = after > before ? after - before : 0n;
  if (received < minOut) {
    // Landed, but short of what was promised. Say so loudly: the caller is
    // about to size a curve buy from this number.
    throw new Error(
      `zap received ${received} of ${q}, below the ${minOut} minimum — tx ${hash}`,
    );
  }
  return { hash, received, route: expected.route };
}
