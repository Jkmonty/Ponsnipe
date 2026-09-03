/**
 * Connectivity + contract sanity check. No private key needed.
 *
 *   npm run smoke                 # chain + pons v2 factory reachable? recent launches?
 *   npm run smoke -- 0xTOKEN      # resolve a token: curve, price, graduation
 */
try {
  process.loadEnvFile?.(".env");
} catch {
  /* ignore */
}

import { createPublicClient, http, isAddress, getAddress, parseAbiItem } from "viem";

const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = Number(process.env.CHAIN_ID || 4663);
const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";

async function main() {
  const client = createPublicClient({ transport: http(RPC) });

  const [chainId, block] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
  // Never print the key — provider URLs carry it in the path.
  console.log(`RPC        : ${RPC.replace(/\/v2\/.*$/, "/v2/***").replace(/([?&]api[-_]?key=)[^&]+/i, "$1***")}`);
  console.log(`chainId    : ${chainId} ${chainId === CHAIN_ID ? "OK" : `EXPECTED ${CHAIN_ID}`}`);
  console.log(`head block : ${block}`);

  const code = await client.getCode({ address: getAddress(FACTORY) }).catch(() => undefined);
  console.log(`v2 factory : ${FACTORY} ${code && code !== "0x" ? "OK" : "NO CODE"}`);

  const logs = await client
    .getLogs({
      address: getAddress(FACTORY),
      event: parseAbiItem(
        "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
      ),
      // Keep this tiny: provider free tiers cap eth_getLogs ranges hard
      // (Alchemy free allows only 10 blocks). Bulk history is the backtest's
      // job, and it uses the public endpoint for exactly this reason.
      fromBlock: block - 9n,
      toBlock: block,
    })
    .catch((e) => {
      console.log("getLogs error:", e.shortMessage || e.message);
      return [];
    });
  console.log(`launches in last 10 blocks: ${logs.length}`);
  for (const l of logs.slice(-3)) {
    console.log(`  token ${l.args.token}  curve ${l.args.curve}`);
  }

  const tokenArg = process.argv.slice(2).find((a) => a.startsWith("0x"));
  if (!tokenArg) {
    console.log(`\nPass a token address to test curve resolution + pricing.`);
    if (logs.length) console.log(`e.g. npm run smoke -- ${logs[logs.length - 1].args.token}`);
    return;
  }
  if (!isAddress(tokenArg)) {
    console.error(`\n${tokenArg} is not a valid address`);
    process.exit(1);
  }

  console.log(`\nResolving ${tokenArg} ...`);
  const { getTokenSnapshot } = await import("../src/lib/pons/tokens");
  const snap = await getTokenSnapshot(tokenArg);
  console.log(
    JSON.stringify(snap, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
  );
  if (snap.venue === "none") {
    console.log(`\nNot a pons v2 launch: ${snap.reason}`);
  } else {
    console.log(
      `\ncurve ${snap.curve} · price ${snap.price.priceQuote} ${snap.quoteSymbol} · ` +
        `fee ${snap.feeBps}bps · grad ${snap.graduation.progressPct.toFixed(1)}% · ` +
        `tradeable ${snap.tradeable}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
