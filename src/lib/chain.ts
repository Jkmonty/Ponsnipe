import { createPublicClient, defineChain, http, type PublicClient } from "viem";
import { env } from "./env";

/** Robinhood Chain — Arbitrum Orbit L2, gas token ETH. */
export const robinhoodChain = defineChain({
  id: env.chainId,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [env.rpcUrl] },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
    },
  },
  contracts: {
    // Canonical Multicall3, verified deployed on Robinhood Chain — lets the
    // monitor price every open position in one eth_call.
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

let _public: PublicClient | undefined;

/** Shared read-only RPC client. */
export function publicClient(): PublicClient {
  if (!_public) {
    _public = createPublicClient({
      chain: robinhoodChain,
      transport: http(env.rpcUrl, { batch: true, retryCount: 2 }),
      // Drives watchBlockNumber / watchContractEvent cadence.
      pollingInterval: env.pollingIntervalMs,
      // Batch all open-position reads into one eth_call per pass.
      batch: { multicall: { wait: 16 } },
    });
  }
  return _public;
}
