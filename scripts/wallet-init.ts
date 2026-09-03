/**
 * Create or import the bot wallet and write it to an encrypted keystore.
 *
 *   npm run wallet:init                      # generate a fresh wallet
 *   npm run wallet:init -- --import 0xKEY    # import an existing private key
 *   npm run wallet:init -- --force           # overwrite an existing keystore
 *
 * Prefer feeding the key via the PRIVATE_KEY env var instead of --import so it
 * doesn't land in your shell history.
 */
import { existsSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

try {
  process.loadEnvFile?.(".env");
} catch {
  /* no .env yet */
}

import { encryptPrivateKey, saveKeystore } from "../src/lib/wallet/keystore";

const args = process.argv.slice(2);
const force = args.includes("--force");
const importIdx = args.indexOf("--import");
const importedKey =
  importIdx >= 0 ? args[importIdx + 1] : process.env.PRIVATE_KEY ?? "";

const passphrase = process.env.KEYSTORE_PASSPHRASE?.trim() ?? "";
const path = process.env.KEYSTORE_PATH?.trim() || "./data/bot.keystore.json";

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

if (!passphrase) fail("Set KEYSTORE_PASSPHRASE in .env first (min 12 chars).");
if (passphrase.length < 12) fail("KEYSTORE_PASSPHRASE must be at least 12 characters.");
if (existsSync(path) && !force) {
  fail(`Keystore already exists at ${path}. Re-run with --force to overwrite.`);
}

let pk: Hex;
if (importedKey) {
  const norm = (importedKey.startsWith("0x") ? importedKey : `0x${importedKey}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(norm)) fail("Imported key is not a 32-byte hex private key.");
  pk = norm;
  console.log("Importing provided private key…");
} else {
  pk = generatePrivateKey();
  console.log("Generated a fresh private key.");
}

const account = privateKeyToAccount(pk);
const file = encryptPrivateKey(pk, passphrase, account.address);
saveKeystore(path, file);

console.log(`\n✓ Bot wallet ready`);
console.log(`  address : ${account.address}`);
console.log(`  keystore: ${path} (AES-256-GCM, do NOT commit)`);
console.log(`\nNext steps:`);
console.log(`  1. Send some ETH on Robinhood Chain to ${account.address}`);
console.log(`  2. Keep ENGINE_LIVE=0 until you've run \`npm run smoke\` and a tiny test buy`);
console.log(`  3. Start the app: npm run dev\n`);

if (!importedKey) {
  console.log("The private key is only stored in the encrypted keystore.");
  console.log("Back up the keystore file AND your KEYSTORE_PASSPHRASE separately.\n");
}
