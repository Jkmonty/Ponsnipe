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

  // The new-coins feed. Read-only, on its own public-endpoint client, and
  // deliberately independent of the sniper — the list has to keep updating
  // whether or not anything is armed to trade.
  const { startFeed } = await import("./lib/feed/market");
  try {
    startFeed();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to start feed:", err);
  }

  // Pushed launches, on top of the sweep rather than instead of it. Free, no
  // key: publicnode runs a WebSocket for this chain that takes eth_subscribe,
  // which the endpoint we sweep does not.
  const { startLaunchStream } = await import("./lib/feed/livestream");
  try {
    startLaunchStream();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to start launch stream:", err);
  }
}
