import { json, errorJson } from "@/lib/api";
import { hasBotWallet, getBotBalance } from "@/lib/wallet/botWallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!hasBotWallet()) {
    return json({ configured: false, hint: "run `npm run wallet:init`" });
  }
  try {
    const bal = await getBotBalance();
    return json({
      configured: true,
      address: bal.address,
      eth: bal.eth,
      ethWei: bal.ethWei,
    });
  } catch (err) {
    return errorJson(
      err instanceof Error ? err.message : "failed to read bot wallet",
      500,
    );
  }
}
