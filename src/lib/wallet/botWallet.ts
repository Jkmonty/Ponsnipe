import {
  createWalletClient,
  http,
  formatEther,
  nonceManager,
  type Address,
  type WalletClient,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "../env";
import { robinhoodChain, publicClient } from "../chain";
import { loadKeystoreFile, decryptPrivateKey, keystoreExists } from "./keystore";

interface WalletSingleton {
  account: Account;
  wallet: WalletClient;
}

/**
 * globalThis-backed: Next runs instrumentation and route handlers in separate
 * module registries. A per-registry copy would mean two independent
 * `nonceManager` instances handing out the SAME nonce to concurrent
 * transactions (e.g. a sniper buy and a monitor sell), so one would replace the
 * other or fail with "nonce too low". One shared account, one nonce sequence.
 */
const gw = globalThis as typeof globalThis & { __ponsWallet?: WalletSingleton };

/** Decrypt the keystore once and cache the resulting account + wallet client. */
function ensureLoaded(): WalletSingleton {
  if (gw.__ponsWallet) return gw.__ponsWallet;
  if (!env.keystorePassphrase) {
    throw new Error("KEYSTORE_PASSPHRASE is not set — cannot unlock the bot wallet");
  }
  const file = loadKeystoreFile(env.keystorePath);
  const pk = decryptPrivateKey(file, env.keystorePassphrase);
  // nonceManager caches + locally increments the nonce, so an auto-sell doesn't
  // spend an RPC round-trip fetching it at trigger time.
  const account = privateKeyToAccount(pk, { nonceManager });
  const wallet = createWalletClient({
    account,
    chain: robinhoodChain,
    transport: http(env.rpcUrl, { retryCount: 2 }),
  });
  gw.__ponsWallet = { account, wallet };
  return gw.__ponsWallet;
}

/** Drop the cached wallet (e.g. after the keystore is replaced). */
export function resetBotWallet(): void {
  delete gw.__ponsWallet;
}

export function botWallet(): { account: Account; wallet: WalletClient } {
  return ensureLoaded();
}

export function botAddress(): Address {
  return ensureLoaded().account.address;
}

export function hasBotWallet(): boolean {
  return keystoreExists(env.keystorePath);
}

export interface BotBalance {
  address: Address;
  eth: string;
  ethWei: bigint;
}

export async function getBotBalance(): Promise<BotBalance> {
  const address = botAddress();
  const ethWei = await publicClient().getBalance({ address });
  return { address, eth: formatEther(ethWei), ethWei };
}
