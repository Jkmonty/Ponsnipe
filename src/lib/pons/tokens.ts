import { getAddress, formatEther, type Address } from "viem";
import { readClient, rpcFailureReason } from "../chain";
import { PONS, NATIVE_QUOTE, GRADUATION_ETH_THRESHOLD } from "./addresses";
import { erc20Abi, ponsFactoryAbi, bondingCurveAbi } from "./abis";
import { priceFromReserves, type TokenPrice, type CurveReserves } from "./pricing";

export type Venue = "curve" | "graduated" | "none";

export interface TokenSnapshot {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  /** Artwork URL from the token's own logo() view; "" when it has none. */
  logo: string;

  venue: Venue;
  /** Bonding curve contract (venue === "curve"). */
  curve: Address | null;
  /** Quote asset the curve trades against; 0x0 === native ETH. */
  pairToken: Address;
  quoteSymbol: string;
  quoteDecimals: number;
  quoteIsNative: boolean;

  feeBps: number;
  creatorTaxBps: number;

  reserves: CurveReserves;
  /** Token price denominated in the quote asset. */
  price: TokenPrice;
  /** Fully-diluted value in the quote asset. */
  fdvQuote: number;

  graduation: {
    graduated: boolean;
    readyToGraduate: boolean;
    currentQuote: number;
    thresholdQuote: number;
    /** Raw threshold in quote units — stored on the position for the exit rule. */
    thresholdWei: bigint;
    progressPct: number;
  };

  tradeable: boolean;
  /** Set when tradeable === false. */
  reason?: string;
}

const ZERO: CurveReserves = { quoteReserve: 0n, tokenReserve: 0n };

async function erc20Meta(addr: Address) {
  const c = readClient();
  const [name, symbol, decimals] = await Promise.all([
    c.readContract({ address: addr, abi: erc20Abi, functionName: "name" }).catch(() => "Unknown"),
    c.readContract({ address: addr, abi: erc20Abi, functionName: "symbol" }).catch(() => "???"),
    c
      .readContract({ address: addr, abi: erc20Abi, functionName: "decimals" })
      .then(Number)
      .catch(() => 18),
  ]);
  return { name: name as string, symbol: symbol as string, decimals };
}

export async function getTokenSnapshot(raw: string): Promise<TokenSnapshot> {
  const token = getAddress(raw);
  const c = readClient();

  // A failed factory read and a token the factory has never heard of both come
  // back as "no launch". They mean opposite things to the user, so keep the
  // error rather than reporting an RPC outage as an unknown token.
  let readError: string | null = null;

  const [meta, totalSupply, launch] = await Promise.all([
    erc20Meta(token),
    c.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }).catch(() => 0n),
    c
      .readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "getLaunchedToken", args: [token] })
      .catch((err) => {
        readError = rpcFailureReason(err);
        return null;
      }),
  ]);

  const base: TokenSnapshot = {
    address: token,
    name: meta.name,
    symbol: meta.symbol,
    decimals: meta.decimals,
    logo: "",
    totalSupply: totalSupply as bigint,
    venue: "none",
    curve: null,
    pairToken: NATIVE_QUOTE,
    quoteSymbol: "ETH",
    quoteDecimals: 18,
    quoteIsNative: true,
    feeBps: 0,
    creatorTaxBps: 0,
    reserves: ZERO,
    price: { priceQuoteWad: 0n, priceQuote: 0 },
    fdvQuote: 0,
    graduation: {
      graduated: false,
      readyToGraduate: false,
      currentQuote: 0,
      thresholdQuote: GRADUATION_ETH_THRESHOLD,
      thresholdWei: 0n,
      progressPct: 0,
    },
    tradeable: false,
  };

  if (!launch || !(launch as { exists: boolean }).exists) {
    return { ...base, reason: readError ?? "not a pons v2 launch (or unknown token)" };
  }

  const l = launch as {
    curve: Address;
    pairToken: Address;
    graduationThreshold: bigint;
    creatorTaxBps: number;
    phase: number;
  };
  const curve = getAddress(l.curve);
  const pairToken = getAddress(l.pairToken);
  const quoteIsNative = pairToken === NATIVE_QUOTE;

  const quoteMeta = quoteIsNative
    ? { symbol: "ETH", decimals: 18 }
    : await erc20Meta(pairToken).then((m) => ({ symbol: m.symbol, decimals: m.decimals }));

  const [reservesRaw, graduated, readyToGraduate, feeBps, realQuoteReserve, logo] = await Promise.all([
    // Not every address the factory points at answers getReserves — a curve
    // can be mid-migration, or the launch config can use a shape we do not
    // know. Returning zeros marks it untradeable instead of throwing the whole
    // evaluation away, which was surfacing as an engine error on the feed.
    (c.readContract({ address: curve, abi: bondingCurveAbi, functionName: "getReserves" }) as Promise<
      readonly [bigint, bigint]
    >).catch(() => [0n, 0n] as readonly [bigint, bigint]),
    c.readContract({ address: curve, abi: bondingCurveAbi, functionName: "graduated" }).catch(() => false),
    c.readContract({ address: curve, abi: bondingCurveAbi, functionName: "readyToGraduate" }).catch(() => false),
    c.readContract({ address: curve, abi: bondingCurveAbi, functionName: "feeBps" }).then(Number).catch(() => 100),
    c.readContract({ address: curve, abi: bondingCurveAbi, functionName: "realQuoteReserve" }).catch(() => 0n),
    // Artwork, for the launch feeds. Absent on some tokens; never fatal.
    c.readContract({ address: token, abi: erc20Abi, functionName: "logo" })
      .then((v) => String(v))
      .catch(() => ""),
  ]);

  const reserves: CurveReserves = { quoteReserve: reservesRaw[0], tokenReserve: reservesRaw[1] };
  const price = priceFromReserves(reserves, meta.decimals, quoteMeta.decimals);
  const fdvQuote = (Number(totalSupply) / 10 ** meta.decimals) * price.priceQuote;

  const thresholdQuote = Number(l.graduationThreshold) / 10 ** quoteMeta.decimals;
  const currentQuote = Number(realQuoteReserve as bigint) / 10 ** quoteMeta.decimals;
  const isGraduated = Boolean(graduated) || l.phase !== 0;

  const priceable = reserves.quoteReserve > 0n && reserves.tokenReserve > 0n;
  const tradeable = !isGraduated && !readyToGraduate && priceable;

  return {
    ...base,
    venue: isGraduated ? "graduated" : "curve",
    curve,
    pairToken,
    logo,
    quoteSymbol: quoteMeta.symbol,
    quoteDecimals: quoteMeta.decimals,
    quoteIsNative,
    feeBps,
    creatorTaxBps: Number(l.creatorTaxBps),
    reserves,
    price,
    fdvQuote,
    graduation: {
      graduated: isGraduated,
      readyToGraduate: Boolean(readyToGraduate),
      currentQuote,
      thresholdQuote,
      thresholdWei: l.graduationThreshold,
      progressPct: thresholdQuote > 0 ? Math.min(100, (currentQuote / thresholdQuote) * 100) : 0,
    },
    tradeable,
    // Graduation is tested FIRST. Migrating empties the curve, so a graduated
    // token always fails the reserves check too — and reporting that symptom
    // ("curve did not report reserves") instead of the cause told the user
    // nothing and looked like a fault in the app.
    reason: isGraduated
      ? "already graduated — its curve is closed, trade it on pons.family"
      : readyToGraduate
        ? "about to graduate — the curve has stopped trading"
        : !priceable
          ? "curve did not report reserves"
          : undefined,
  };
}

export interface CurveState {
  reserves: CurveReserves;
  price: TokenPrice;
  graduated: boolean;
  readyToGraduate: boolean;
  feeBps: number;
  creatorTaxBps: number;
}

/** Fast path for the monitor/executor: current price + tradeability of a curve. */
export async function getCurveState(params: {
  curve: Address;
  tokenDecimals: number;
  quoteDecimals: number;
  creatorTaxBps: number;
}): Promise<CurveState> {
  const c = readClient();
  const [reservesRaw, graduated, ready, feeBps] = await Promise.all([
    c.readContract({ address: params.curve, abi: bondingCurveAbi, functionName: "getReserves" }) as Promise<
      readonly [bigint, bigint]
    >,
    c.readContract({ address: params.curve, abi: bondingCurveAbi, functionName: "graduated" }).catch(() => false),
    c.readContract({ address: params.curve, abi: bondingCurveAbi, functionName: "readyToGraduate" }).catch(() => false),
    c.readContract({ address: params.curve, abi: bondingCurveAbi, functionName: "feeBps" }).then(Number).catch(() => 100),
  ]);
  const reserves: CurveReserves = { quoteReserve: reservesRaw[0], tokenReserve: reservesRaw[1] };
  return {
    reserves,
    price: priceFromReserves(reserves, params.tokenDecimals, params.quoteDecimals),
    graduated: Boolean(graduated),
    readyToGraduate: Boolean(ready),
    feeBps,
    creatorTaxBps: params.creatorTaxBps,
  };
}

export function formatQuote(wei: bigint, decimals: number): string {
  return decimals === 18 ? formatEther(wei) : (Number(wei) / 10 ** decimals).toString();
}
