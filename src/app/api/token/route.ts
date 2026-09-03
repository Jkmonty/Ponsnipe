import { isAddress } from "viem";
import { json, errorJson } from "@/lib/api";
import { getTokenSnapshot } from "@/lib/pons/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get("address")?.trim() ?? "";
  if (!isAddress(address)) return errorJson("invalid token address");
  try {
    const snap = await getTokenSnapshot(address);
    return json(snap);
  } catch (err) {
    return errorJson(
      err instanceof Error ? err.message : "failed to load token",
      502,
    );
  }
}
