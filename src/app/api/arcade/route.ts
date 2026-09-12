import { isAddress } from "viem";
import { json, errorJson } from "@/lib/api";
import { rankOf, submit, top, weekEnds, weekOf } from "@/lib/arcade";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The weekly board, and somewhere to post a run to it.
 *
 * A score arrives from a browser and therefore cannot be trusted. Rather than
 * pretend, the obviously impossible is refused here and everything else is
 * stored with the shape of the run attached — shots, hits, how long it took —
 * so a human can look at the top of the board before anybody is paid.
 */
const MAX_POINTS = 1_000_000;
/** Nobody fires faster than this. Below it, the run was not played. */
const MIN_MS_PER_SHOT = 90;

export async function GET(req: Request) {
  const u = new URL(req.url);
  const wallet = u.searchParams.get("wallet")?.trim() ?? "";
  try {
    const week = weekOf();
    return json({
      week,
      endsAt: weekEnds(week),
      top: top(100),
      you: wallet && isAddress(wallet) ? rankOf(wallet) : null,
    });
  } catch (err) {
    return errorJson(err instanceof Error ? err.message : "could not read the board", 502);
  }
}

export async function POST(req: Request) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const wallet = String(b.wallet ?? "").trim();
    // A wallet is the identity, because a prize has to be sent somewhere. No
    // signature: proving ownership matters when paying out, not when playing.
    if (!isAddress(wallet)) return errorJson("a wallet address is needed to be ranked");

    const points = Math.floor(Number(b.points) || 0);
    const hits = Math.floor(Number(b.hits) || 0);
    const shots = Math.floor(Number(b.shots) || 0);
    const ms = Math.floor(Number(b.ms) || 0);

    if (points < 0 || points > MAX_POINTS) return errorJson("that score is not possible");
    if (hits > shots) return errorJson("more hits than shots");
    if (shots > 0 && ms / shots < MIN_MS_PER_SHOT) return errorJson("that run is too fast to be real");

    const res = submit({
      wallet,
      name: String(b.name ?? "").trim(),
      points,
      hits,
      shots,
      ms,
    });
    return json({ ...res, week: weekOf(), rank: rankOf(wallet)?.rank ?? null });
  } catch (err) {
    return errorJson(err instanceof Error ? err.message : "could not post that score", 502);
  }
}
