import {
  createPublicClient,
  defineChain,
  http,
  webSocket,
  type PublicClient,
} from "viem";
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

/**
 * globalThis-backed so instrumentation and route handlers share one client —
 * and, with WebSocket, one subscription rather than several.
 */
const gc = globalThis as typeof globalThis & { __ponsPublicClient?: PublicClient };

/** True when we're on a WebSocket transport, i.e. events are pushed to us. */
export function isWebSocket(): boolean {
  return env.wssUrl.startsWith("ws");
}

/** Shared read-only RPC client. */
export function publicClient(): PublicClient {
  if (gc.__ponsPublicClient) return gc.__ponsPublicClient;
  gc.__ponsPublicClient = createPublicClient({
    chain: robinhoodChain,
    // A WebSocket lets viem use eth_subscribe for blocks and logs, so new
    // blocks and curve trades arrive as pushes instead of being polled for.
    // Falls back to HTTP polling when WSS_URL isn't set.
    transport: isWebSocket()
      ? webSocket(env.wssUrl, { retryCount: 3, keepAlive: true, reconnect: true })
      : http(env.rpcUrl, { batch: true, retryCount: 2 }),
    // Only meaningful on HTTP; harmless otherwise.
    pollingInterval: env.pollingIntervalMs,
    // Batch all open-position reads into one eth_call per pass.
    batch: { multicall: { wait: 16 } },
  });
  return gc.__ponsPublicClient;
}
