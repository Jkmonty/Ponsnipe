import {
  createPublicClient,
  defineChain,
  fallback,
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
const gc = globalThis as typeof globalThis & {
  __ponsPublicClient?: PublicClient;
  __ponsReadClient?: PublicClient;
};

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

/**
 * Client for one-off contract reads: balances, quotes, token snapshots, logs.
 *
 * Deliberately HTTP-only and deliberately a fallback chain. A private endpoint
 * that has exhausted its monthly quota rejects every request, and because most
 * read paths treat a failed read as "no data" that surfaces to the user as a
 * missing or unknown token. The public endpoint is slower but always answers,
 * so a dead primary degrades latency instead of breaking lookups.
 *
 * It is not used for watchBlockNumber/watchContractEvent — viem's fallback
 * transport has no eth_subscribe, so those stay on publicClient() to keep the
 * WebSocket push path (~96ms/block vs ~570ms polled).
 */
export function readClient(): PublicClient {
  if (gc.__ponsReadClient) return gc.__ponsReadClient;
  const urls = [env.rpcUrl, env.fallbackRpcUrl].filter(
    (u, i, a) => u && a.indexOf(u) === i,
  );
  gc.__ponsReadClient = createPublicClient({
    chain: robinhoodChain,
    transport: fallback(
      urls.map((u) => http(u, { batch: true, retryCount: 1 })),
      { retryCount: 0 },
    ),
    batch: { multicall: { wait: 16 } },
  });
  return gc.__ponsReadClient;
}

/** Strip any URL so an API key can never reach the UI through an error string. */
export function redactRpc(msg: string): string {
  return msg.replace(/https?:\/\/\S+|wss?:\/\/\S+/gi, "<rpc>");
}

/**
 * A short, user-facing reason for a failed RPC read. Provider quota messages
 * are the common case and say nothing about the token, so name them plainly
 * rather than letting the caller guess.
 */
export function rpcFailureReason(err: unknown): string {
  const raw = redactRpc(String((err as { message?: string })?.message ?? err));
  if (/capacity limit|quota|exceeded your|rate ?limit|429/i.test(raw)) {
    return "RPC provider is out of capacity — set FALLBACK_RPC_URL or wait for the quota to reset.";
  }
  return `RPC read failed: ${raw.split(/\r?\n/)[0].slice(0, 140)}`;
}
