import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { json, errorJson, requireAuth } from "@/lib/api";
import { env } from "@/lib/env";
import { encryptPrivateKey, saveKeystore, keystoreExists } from "@/lib/wallet/keystore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create the bot wallet from the UI, or import an existing key.
 *
 * The app has to hold a key of its own: the whole point is selling while you
 * are asleep, and a browser wallet cannot sign then. So this is a hot wallet
 * holding only what is being traded — not somewhere to keep a balance.
 *
 * Importing is offered because some people would rather bring a wallet they
 * already control than trust one this app generated. The key never leaves the
 * machine either way; it is encrypted at rest with KEYSTORE_PASSPHRASE.
 */
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

  const body = (await req.json().catch(() => null)) as { privateKey?: string } | null;
  const supplied = body?.privateKey?.trim();

  let pk: `0x${string}`;
  if (supplied) {
    const hex = (supplied.startsWith("0x") ? supplied : `0x${supplied}`).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hex)) {
      return errorJson("That does not look like a private key (expected 64 hex characters).", 400);
    }
    pk = hex as `0x${string}`;
  } else {
    pk = generatePrivateKey();
  }

  let account;
  try {
    account = privateKeyToAccount(pk);
  } catch {
    return errorJson("That private key is not valid.", 400);
  }
  saveKeystore(env.keystorePath, encryptPrivateKey(pk, env.keystorePassphrase, account.address));

  return json({ created: true, imported: Boolean(supplied), address: account.address });
}
