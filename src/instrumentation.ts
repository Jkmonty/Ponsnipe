/**
 * Boots the trading monitor loop inside the Next.js server process.
 * Runs once on server start (dev and prod), Node.js runtime only.
 *
 * NOTE: on serverless hosts (Vercel) this will not stay alive between requests.
 * For production, run the monitor on a persistent host — see README "Going live".
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startMonitor } = await import("./lib/engine/monitor");
  try {
    startMonitor();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to start monitor:", err);
  }

  const { startSniper } = await import("./lib/sniper/engine");
  try {
    startSniper();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to start sniper:", err);
  }

}
