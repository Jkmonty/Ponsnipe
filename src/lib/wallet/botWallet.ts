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

let _account: Account | undefined;
let _wallet: WalletClient | undefined;

/** Decrypt the keystore once and cache the resulting account + wallet client. */
function ensureLoaded(): { account: Account; wallet: WalletClient } {
  if (_account && _wallet) return { account: _account, wallet: _wallet };
  if (!env.keystorePassphrase) {
    throw new Error("KEYSTORE_PASSPHRASE is not set — cannot unlock the bot wallet");
  }
  const file = loadKeystoreFile(env.keystorePath);
  const pk = decryptPrivateKey(file, env.keystorePassphrase);
  // nonceManager caches + locally increments the nonce, so an auto-sell doesn't
  // spend an RPC round-trip fetching it at trigger time.
  _account = privateKeyToAccount(pk, { nonceManager });
  _wallet = createWalletClient({
    account: _account,
    chain: robinhoodChain,
    transport: http(env.rpcUrl, { retryCount: 2 }),
  });
  return { account: _account, wallet: _wallet };
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
