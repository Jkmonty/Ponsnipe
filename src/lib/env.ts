/**
 * Central, validated access to environment configuration.
 * Throws early (at first import on the server) if something required is missing.
 */

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Robinhood's own endpoint. Slower than a private provider, but never bills. */
export const PUBLIC_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";

/**
 * Every public endpoint serving this chain, per chainid.network.
 *
 * Spreading reads over several matters more than any one of them being fast:
 * a single endpoint's rate limit was the whole budget, and hitting it is what
 * made sweeps fail 13% of the time when the poll interval was shortened.
 */
export const PUBLIC_RPC_POOL = [
  "https://rpc.mainnet.chain.robinhood.com",
  "https://robinhood-rpc.publicnode.com",
  "https://rpc.arrowrpc.com",
  "https://rpc.ordofi.network",
];

export const env = {
  rpcUrl: opt("RPC_URL", PUBLIC_RPC_URL),
  /**
   * Backstop for contract reads when the primary endpoint refuses — a private
   * provider that has hit its monthly quota fails every call, which otherwise
   * looks like "this token does not exist" rather than "I am out of credit".
   */
  fallbackRpcUrl: opt("FALLBACK_RPC_URL", PUBLIC_RPC_URL),
  /**
   * Optional WebSocket endpoint. When set, the monitor and sniper switch from
   * polling to eth_subscribe — blocks and curve trades are PUSHED to us, which
   * removes the polling interval from exit latency entirely.
   */
  wssUrl: process.env.WSS_URL?.trim() ?? "",
  chainId: num("CHAIN_ID", 4663),

  keystorePassphrase: process.env.KEYSTORE_PASSPHRASE?.trim() ?? "",
  keystorePath: opt("KEYSTORE_PATH", "./data/bot.keystore.json"),

  /** Safety-net heartbeat: a full re-evaluation always runs at least this often. */
  monitorHeartbeatMs: Math.max(1000, num("MONITOR_HEARTBEAT_MS", num("MONITOR_INTERVAL_MS", 4000))),
  /** How often viem polls the RPC for new blocks (the real reaction cadence). */
  pollingIntervalMs: Math.min(5000, Math.max(150, num("POLLING_INTERVAL_MS", 400))),
  engineLive: opt("ENGINE_LIVE", "0") === "1",
  defaultSlippageBps: Math.min(5000, Math.max(10, num("DEFAULT_SLIPPAGE_BPS", 300))),
  /** Priority-fee multiplier applied to auto-sell txs so they land in the next block. */
  sellGasMultiplier: Math.min(4, Math.max(1, num("SELL_GAS_MULTIPLIER", 1.3))),

  databasePath: opt("DATABASE_PATH", "./data/positions.sqlite"),
  apiToken: process.env.ENGINE_API_TOKEN?.trim() ?? "",

  /**
   * Serve the feed and nothing else.
   *
   * For an instance put on a public URL. Every route that moves funds already
   * refuses a non-loopback request without ENGINE_API_TOKEN, so this is not
   * what makes hosting safe — it is what makes it honest. Without it a visitor
   * is shown a wallet card, a buy form and a sniper switch that all fail with
   * 401 when touched, which reads as a broken app rather than a deliberately
   * read-only one.
   *
   * It also stops /api/wallet handing the bot's address and balance to anyone
   * who asks. That is public on-chain data, but there is no reason to tie it
   * to this instance for every passer-by.
   */
  publicMode: process.env.PUBLIC_MODE === "1",
};

/** Throw unless the bot wallet + API are fully configured for live use. */
export function assertEngineConfigured(): void {
  if (!env.keystorePassphrase) throw new Error("KEYSTORE_PASSPHRASE is not set");
  if (!env.apiToken) throw new Error("ENGINE_API_TOKEN is not set");
}
