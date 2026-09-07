import { env } from "@/lib/env";
import { json } from "@/lib/api";
import { hasBotWallet, botAddress, getBotBalance } from "@/lib/wallet/botWallet";
import { redactRpc } from "@/lib/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whether a wallet exists is a question about a file on disk, and it is
 * answered separately from what is in it.
 *
 * These were one call, so a transient RPC failure reading the balance returned
 * a 500, the dashboard saw no `configured` flag, and the setup flow reset to
 * "Create a wallet" — telling someone their wallet is gone because a public
 * node hiccuped. The keystore is the source of truth for existence; the
 * balance is extra, and its absence is reported as an unknown balance rather
 * than an absent wallet.
 */
export async function GET() {
  // A read-only instance has no wallet as far as anyone asking is concerned.
  if (env.publicMode) return json({ configured: false, publicMode: true });

  if (!hasBotWallet()) {
    return json({ configured: false, hint: "run `npm run wallet:init`" });
  }

  try {
    const bal = await getBotBalance();
    return json({ configured: true, address: bal.address, eth: bal.eth, ethWei: bal.ethWei });
  } catch (err) {
    return json({
      configured: true,
      address: botAddress(),
      eth: null,
      ethWei: null,
      balanceError: redactRpc(err instanceof Error ? err.message : String(err)).split(/\r?\n/)[0],
    });
  }
}
