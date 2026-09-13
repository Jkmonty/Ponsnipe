import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { top, weekEnds, weekOf, type Score } from "@/lib/arcade";
import { poolBalance, type PoolInfo } from "@/lib/pool";
import { loadTargets, pickPins, type Pin } from "@/lib/targets";
import Hero from "./Hero";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Ponsnipe — pick your shot",
  description:
    "Every pons launch on Robinhood Chain the second it exists, exits set before entry, and a range where today's tickers are the targets.",
};

/**
 * Nothing on this page blocks on a network call. Each live section gets its
 * data through here and falls back to a quiet state, never a spinner.
 */
async function safely<T>(work: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await work();
  } catch {
    return fallback;
  }
}

/**
 * The front door.
 *
 * Only a hosted instance has strangers. On a local install the root goes
 * straight to the tool, so `npm run dev` still opens the terminal.
 */
export default async function Landing() {
  if (!env.publicMode) redirect("/terminal");

  const week = weekOf();
  const [board, pins, pool] = await Promise.all([
    safely<Score[]>(() => top(3, week), []),
    safely<Pin[]>(async () => pickPins(await loadTargets()), []),
    safely<PoolInfo | null>(() => poolBalance(), null),
  ]);

  return (
    <main className="site-main">
      <Hero pins={pins} board={board} endsAt={weekEnds(week)} pool={pool} />
    </main>
  );
}
