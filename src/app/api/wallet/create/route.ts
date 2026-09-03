import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { json, errorJson, requireAuth } from "@/lib/api";
import { env } from "@/lib/env";
import { encryptPrivateKey, saveKeystore, keystoreExists } from "@/lib/wallet/keystore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create the bot wallet from the UI (no CLI needed). */
export async function POST(req: Request) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  if (!env.keystorePassphrase || env.keystorePassphrase.length < 12) {
    return errorJson(
      "KEYSTORE_PASSPHRASE is missing or too short. Run `npm run setup` once, then restart.",
      409,
    );
  }
  if (keystoreExists(env.keystorePath)) {
    return errorJson("A bot wallet already exists.", 409);
  }

  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  saveKeystore(env.keystorePath, encryptPrivateKey(pk, env.keystorePassphrase, account.address));

  return json({ created: true, address: account.address });
}
