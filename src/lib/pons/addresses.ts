import type { Address } from "viem";

/**
 * pons.family / Robinhood Chain (chainId 4663).
 *
 * Verified against live chain state (see `npm run smoke`):
 * - The ACTIVE launchpad is pons v2: a constant-product bonding curve per token
 *   that graduates into a locked Uniswap v4 pool at ~4.2 ETH.
 * - Every token has its own curve contract. Trade by calling buy()/sell() on
 *   that curve while it is pre-graduation. Post-graduation trading is a v4 pool
 *   (not yet supported here).
 * - `factoryV1` is the older Uniswap-v3 launchpad — mostly dormant, kept for
 *   read-only fallback.
 */
export const PONS = {
  /** pons v2 launch factory — getLaunchedToken(token) => { curve, ... }. */
  factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as Address,

  /** Legacy v1 (Uniswap-v3) factory. */
  factoryV1: "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB" as Address,
  /** Legacy v3 core (for the v1 fallback path only). */
  v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as Address,
  swapRouter: "0xCaf681a66D020601342297493863E78C959E5cb2" as Address,

  /** Canonical WETH on Robinhood Chain (also used as legacy v3 quote asset). */
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address,
} as const;

/** Native ETH is represented as the zero address for a curve's `pairToken`. */
export const NATIVE_QUOTE = "0x0000000000000000000000000000000000000000" as Address;

/** keccak256("TokenLaunched(address,address,address,address,uint256,uint256)") — v2 factory. */
export const TOKEN_LAUNCHED_TOPIC =
  "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607" as const;

/** Default graduation threshold for native-ETH launches (each launch reports its own). */
export const GRADUATION_ETH_THRESHOLD = 4.2;

/**
 * Anti-snipe tax: 99% on a buy in the launch second, decaying to zero across
 * THREE seconds — stated verbatim on the pons launch form, not inferred.
 *
 * We had 15s here, and the sniper still waits 20s to be safe, which means it
 * has been entering roughly 17 seconds later than it needs to. On a curve where
 * price is a function of ETH already deposited, that is real money left behind.
 *
 * Our own event data agrees with the 3s figure and resolves what the scanner
 * logged as "fee anomalies": buys at +0.7s carried 9900bps, +0.9s 718bps,
 * +2.4s 119bps, +3.5s back to the normal 99bps. That is the decay curve, not
 * corrupt data. The fee field was right and the earlier diagnosis was wrong.
 */
export const SNIPE_TAX_WINDOW_SECONDS = 3;
