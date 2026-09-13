import { redirect } from "next/navigation";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * The front door.
 *
 * Only a hosted instance has strangers. On a local install the root goes
 * straight to the tool, so `npm run dev` still opens the terminal.
 */
export default function Landing() {
  if (!env.publicMode) redirect("/terminal");
  return (
    <main>
      <h1>Ponsnipe</h1>
    </main>
  );
}
