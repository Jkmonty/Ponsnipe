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

  // GMGN covers every launchpad on the chain, not just pons curves, so it is
  // the feed's source when a key is configured. The chain indexer keeps running
  // regardless: it is what tells the feed which rows this app can actually buy,
  // and it is what the sniper prices against.
  const { gmgnConfigured, startGmgn } = await import("./lib/feed/gmgn");
  try {
    if (await gmgnConfigured()) startGmgn();
    else console.info("GMGN key not configured — feed will use the on-chain pons index only.");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to start GMGN feed:", err);
  }
}
