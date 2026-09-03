/**
 * pons v2 bonding-curve math — a direct port of
 * contractsV2/src/v2/libraries/PonsV2BondingCurveMath.sol (constant product,
 * Uniswap-v2 style) plus the fee/tax handling from PonsV2BondingCurve.buy/sell.
 *
 * The curve trades the launch token against a "quote" asset — native ETH for
 * the common case (pairToken == 0x0), otherwise a chosen ERC-20. All amounts
 * here are in smallest units (wei-scale) unless noted.
 */

const BASIS_POINTS = 10_000n;
const WAD = 10n ** 18n;

export interface CurveReserves {
  /** Price-relevant quote reserve from curve.getReserves() (incl. phantom). */
  quoteReserve: bigint;
  /** Price-relevant token reserve from curve.getReserves(). */
  tokenReserve: bigint;
}

export interface TokenPrice {
  /** Price of 1 whole token, in the quote asset, scaled 1e18. */
  priceQuoteWad: bigint;
  /** Same as a float (fine for % PnL). */
  priceQuote: number;
}

/** getAmountOut: exact-input constant product, fee in bps taken off the input. */
export function getAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: bigint,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * (BASIS_POINTS - feeBps);
  return (amountInWithFee * reserveOut) / (reserveIn * BASIS_POINTS + amountInWithFee);
}

/** Spot price of the launch token in the quote asset. */
export function priceFromReserves(
  { quoteReserve, tokenReserve }: CurveReserves,
  tokenDecimals: number,
  quoteDecimals: number,
): TokenPrice {
  if (quoteReserve <= 0n || tokenReserve <= 0n) {
    return { priceQuoteWad: 0n, priceQuote: 0 };
  }
  // price = (quoteReserve / 10^qd) / (tokenReserve / 10^td)  ... scaled by 1e18
  const priceQuoteWad =
    (quoteReserve * 10n ** BigInt(tokenDecimals) * WAD) /
    (tokenReserve * 10n ** BigInt(quoteDecimals));
  return { priceQuoteWad, priceQuote: Number(priceQuoteWad) / 1e18 };
}

export interface BuyQuote {
  /** Tokens received (before any on-chain partial-fill clamp near graduation). */
  tokensOut: bigint;
  fee: bigint;
  tax: bigint;
  netQuoteIn: bigint;
}

/** Mirror of PonsV2BondingCurve.buy pricing (no partial-fill clamp). */
export function quoteBuy(
  quoteIn: bigint,
  reserves: CurveReserves,
  feeBps: bigint,
  creatorTaxBps: bigint,
): BuyQuote {
  const fee = (quoteIn * feeBps) / BASIS_POINTS;
  const tax = (quoteIn * creatorTaxBps) / BASIS_POINTS;
  const net = quoteIn - fee - tax;
  const tokensOut = getAmountOut(net, reserves.quoteReserve, reserves.tokenReserve, 0n);
  return { tokensOut, fee, tax, netQuoteIn: net };
}

export interface SellQuote {
  quoteOut: bigint;
  fee: bigint;
  tax: bigint;
  grossQuoteOut: bigint;
}

/** Mirror of PonsV2BondingCurve.sell pricing. */
export function quoteSell(
  tokensIn: bigint,
  reserves: CurveReserves,
  feeBps: bigint,
  creatorTaxBps: bigint,
): SellQuote {
  const grossQuoteOut = getAmountOut(
    tokensIn,
    reserves.tokenReserve,
    reserves.quoteReserve,
    0n,
  );
  const fee = (grossQuoteOut * feeBps) / BASIS_POINTS;
  const tax = (grossQuoteOut * creatorTaxBps) / BASIS_POINTS;
  return { quoteOut: grossQuoteOut - fee - tax, fee, tax, grossQuoteOut };
}

export function applySlippage(amount: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.round(slippageBps)));
  return (amount * (BASIS_POINTS - bps)) / BASIS_POINTS;
}
