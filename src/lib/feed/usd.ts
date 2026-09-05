/**
 * Dollar values for feed numbers.
 *
 * Roughly half of launches pair against ETH and a quarter against USDG, so a
 * single ETH rate plus "a stablecoin is a dollar" prices about three quarters
 * of the market. The rest pair against tokenised stocks — NVDA, SPY, TSLA and
 * a dozen more — and there is no rate for those on this chain: no ETH/USDG
 * pool exists to read, and pricing a dozen equities is a different project.
 *
 * Those are reported as unpriced rather than guessed at. A market cap filter
 * that silently assumed a number for a quarter of the feed would be worse than
 * one that admits what it cannot see.
 */
const STABLES = new Set(["USDG", "USDC", "USDT", "DAI", "PYUSD", "USDS"]);

/** Refetched at most this often; the feed re-reads it on every request. */
const TTL_MS = 300_000;

const gc = globalThis as typeof globalThis & {
  __ponsEthUsd?: { at: number; rate: number | null };
};

/**
 * ETH/USD from Coinbase's public spot endpoint — no key, no account. Set
 * ETH_USD in .env to pin it instead, or if the machine has no outbound
 * internet access beyond the RPC.
 */
async function fetchEthUsd(): Promise<number | null> {
  const pinned = Number(process.env.ETH_USD ?? "");
  if (Number.isFinite(pinned) && pinned > 0) return pinned;
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", {
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: { amount?: string } };
    const n = Number(j?.data?.amount);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export async function ethUsd(): Promise<number | null> {
  const c = gc.__ponsEthUsd;
  if (c && Date.now() - c.at < TTL_MS) return c.rate;
  const rate = await fetchEthUsd();
  // Cache a failure too, briefly, so a dead endpoint is not retried per request.
  gc.__ponsEthUsd = { at: Date.now(), rate };
  return rate;
}

/**
 * Dollars per unit of a quote asset, or null when we cannot know.
 * `null` is a real answer here and callers must handle it.
 */
export function quoteToUsd(quoteSymbol: string, isNative: boolean, eth: number | null): number | null {
  if (isNative || quoteSymbol === "ETH" || quoteSymbol === "WETH") return eth;
  if (STABLES.has(quoteSymbol.toUpperCase())) return 1;
  return null;
}
