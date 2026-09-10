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
  custom,
  fallback,
  getAddress,
  http,
  keccak256,
  parseAbi,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { robinhoodChain } from "@/lib/chain";
import { bondingCurveAbi, erc20Abi } from "@/lib/pons/abis";
import { applySlippage, quoteBuy, type CurveReserves } from "@/lib/pons/pricing";

export const RPCS = [
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

/*
 * Errors that mean the transaction is already in the mempool.
 *
 * Not failures. When the same signed transaction reaches three nodes, two of
 * them are entitled to say they have seen it before — that is the broadcast
 * working, not a problem, and reporting it as one would tell a trader their
 * buy failed while it was being mined.
 */
const ALREADY = ["already known", "known transaction", "already exists", "duplicate transaction"];

/**
 * Send one signed transaction to every endpoint at once.
 *
 * A signed transaction is a fixed string with a fixed hash, so sending it to
 * three nodes cannot buy anything twice — whichever propagates first wins and
 * the rest are redundant. That is the opposite of the read path, where trying
 * endpoints in order is right because a slow answer is still an answer.
 *
 * The hash is computed here rather than taken from whichever node replied, so
 * it is known before the first request leaves and is the same whoever answers.
 *
 * Exported for the tests. This decides whether a trader is told their buy
 * failed, so the cases where a node disagrees with its neighbours are worth
 * pinning down rather than reasoning about once.
 */
export async function broadcast(raw: Hex): Promise<Hex> {
  const hash = keccak256(raw);
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_sendRawTransaction",
    params: [raw],
  });

  const attempt = async (url: string): Promise<Hex> => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      // Short, because this is the request a snipe is waiting on. A node that
      // cannot answer in six seconds has already lost the race to the others.
      signal: AbortSignal.timeout(6_000),
    });
    /*
     * Parsed before the status is judged, not after.
     *
     * Some nodes answer a perfectly good JSON-RPC error — "already known"
     * included — with a 4xx, so refusing on !r.ok would throw away the one
     * reply that means the broadcast worked. But these endpoints sit behind
     * CDNs, and a rate limit or a gateway timeout comes back as an HTML page:
     * r.json() then throws "Unexpected token < in JSON", which is what the
     * trader would be shown instead of "you were throttled".
     *
     * So: read the body as JSON, and if it is not JSON at all, report what the
     * server actually said.
     */
    let j: { result?: Hex; error?: { message?: string } };
    try {
      j = (await r.json()) as { result?: Hex; error?: { message?: string } };
    } catch {
      const host = url.replace(/^https?:\/\//, "").split("/")[0];
      throw new Error(`${host} returned HTTP ${r.status}`);
    }
    if (j.error) {
      const m = String(j.error.message ?? "").toLowerCase();
      if (ALREADY.some((k) => m.includes(k))) return hash;
      throw new Error(j.error.message ?? "broadcast refused");
    }
    if (!j.result) throw new Error("no transaction hash");
    return j.result;
  };

  /*
   * The first acceptance wins; a rejection only counts once every endpoint has
   * given one. Promise.any is exactly this, and its AggregateError carries all
   * of them — the first is reported because they are usually the same reason
   * and a wall of identical text helps nobody.
   */
  try {
    return await Promise.any(RPCS.map(attempt));
  } catch (err) {
    const all = err as AggregateError;
    const first = all?.errors?.[0];
    throw first instanceof Error ? first : new Error("no endpoint accepted the transaction");
  }
}

/**
 * Transport for the wallet: reads through the pool, broadcasts to all of it.
 *
 * Built as a transport rather than as a helper so every existing send goes
 * through it without changing a line at the call sites — and so no future one
 * can be written that quietly misses it.
 */
export function broadcastTransport() {
  return custom(
    {
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === "eth_sendRawTransaction") {
          return broadcast((params as [Hex])[0]);
        }
        // Everything else — nonce, gas, receipts — is an ordinary read, and
        // the pooled client already ranks and retries those.
        return browserPublic().request({ method, params } as never);
      },
    },
    { retryCount: 0 },
  );
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
/**
 * `signer`, not an address.
 *
 * This took an Address, and viem reads a bare address as a JSON-RPC account —
 * one the node is expected to hold the key for. So every write here asked the
 * public endpoint to `eth_sendTransaction` on behalf of a wallet it has never
 * heard of, and every buy failed with "the method does not exist". Passing the
 * local account makes viem sign in the browser and send the raw transaction,
 * which is the whole design of this wallet.
 *
 * The manual buy and sell buttons always passed the account object. This one
 * path did not, which is why it had never worked.
 */
export async function executeBuy(
  wallet: WalletClient,
  signer: Account,
  ethIn: bigint,
  p: BuyPlan,
): Promise<{ hashes: `0x${string}`[]; spentQuote: bigint }> {
  const c = browserPublic();
  const hashes: `0x${string}`[] = [];
  /* Reads, args and recipients want the address; the writes want the signer. */
  const account = signer.address;

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
      account: signer,
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
        account: signer,
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
    account: signer,
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
