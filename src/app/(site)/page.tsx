import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { top, weekEnds, weekOf, type Score } from "@/lib/arcade";
import { poolBalance, type PoolInfo } from "@/lib/pool";
import { loadTargets, pickPins, type Pin } from "@/lib/targets";
import Hero from "./Hero";
import LiveSection from "./LiveSection";
import RangeWindow from "./RangeWindow";
import TerminalClaims from "./TerminalClaims";
import HonestNumbers from "./HonestNumbers";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Ponsnipe — pick your shot",
  description:
    "Every pons launch on Robinhood Chain the second it exists, exits set before entry, and a range where today's tickers are the targets.",
};

/** How long any one data source may hold the page. The sections have quiet states; the page does not wait for them. */
const DEADLINE_MS = 2000;

/**
 * Nothing on this page blocks on a network call. Each live section gets its
 * data through here and falls back to a quiet state, never a spinner: a
 * throw, or a source slower than the deadline, both yield the fallback.
 *
 * Everything passed here is a plain data read. Do not put a redirect() or
 * notFound() inside: Next signals those by throwing, and this would swallow
 * them.
 */
async function safely<T>(work: () => Promise<T> | T, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), DEADLINE_MS);
  });
  try {
    return await Promise.race([Promise.resolve().then(work), deadline]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The front door.
 *
 * Only a hosted instance has strangers. On a local install the root goes
 * straight to the tool, so `npm run dev` still opens the terminal.
 *
 * The live feed is a client component that streams for itself, so the server
 * reads here are only what the hero needs.
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
      <LiveSection />
      <RangeWindow hasPool={pool !== null} />
      <TerminalClaims />
      <HonestNumbers />
    </main>
  );
}
