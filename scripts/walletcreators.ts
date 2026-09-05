/**
 * Does he follow specific deployers?
 *
 * The most copyable version of "how does he know which to snipe" is that he
 * watches a short list of creators and buys whatever they ship. That is
 * testable: take the tokens he bought, find who minted each, and see whether
 * the same creators recur more than chance would give.
 *
 * The control is the base rate of repeat creators across all launches in the
 * same window. Creators here launch repeatedly, so his list repeating a little
 * proves nothing on its own.
 *
 *   npx tsx scripts/walletcreators.ts [wallet] [windowBlocks] [maxTokens]
 */
process.loadEnvFile?.(".env");
import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import { robinhoodChain } from "../src/lib/chain";

const W = (process.argv[2] ?? "0x4f1daedbc131458af1d7515b597ab398dee57fab").toLowerCase() as Address;
const WINDOW = BigInt(process.argv[3] ?? "300000");
const MAX = Number(process.argv[4] ?? 45);

const ZERO = "0x0000000000000000000000000000000000000000";
const XFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const c = createPublicClient({
  chain: robinhoodChain,
  transport: http(process.env.LOGS_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", {
    retryCount: 3,
    timeout: 40_000,
  }),
});

/** Who minted a token: the sender of the transaction carrying its mint. */
async function creatorOf(token: string, near: bigint): Promise<{ creator: string; factory: string } | null> {
  for (let back = 0n; back < 80_000n; back += 20_000n) {
    const hi = near - back;
    const lo = hi - 19_999n < 0n ? 0n : hi - 19_999n;
    const lg = await c
      .getLogs({ address: token as Address, event: XFER, args: { from: ZERO }, fromBlock: lo, toBlock: hi })
      .catch(() => []);
    if (!lg.length) continue;
    const tx = await c.getTransaction({ hash: lg[0].transactionHash! }).catch(() => null);
    if (!tx) return null;
    return { creator: String(tx.from).toLowerCase(), factory: String(tx.to ?? "").toLowerCase() };
  }
  return null;
}

async function main() {
  const head = await c.getBlockNumber();

  // Tokens he acquired, newest first.
  const firstSeen = new Map<string, bigint>();
  for (let b = head - WINDOW; b <= head; b += 50_000n) {
    const hi = b + 49_999n > head ? head : b + 49_999n;
    const lg = await c.getLogs({ event: XFER, args: { to: W }, fromBlock: b, toBlock: hi }).catch(() => []);
    for (const l of lg) {
      const t = String(l.address).toLowerCase();
      const prev = firstSeen.get(t);
      if (prev === undefined || l.blockNumber! < prev) firstSeen.set(t, l.blockNumber!);
    }
  }
  const tokens = [...firstSeen.entries()].sort((a, b) => Number(b[1] - a[1])).slice(0, MAX);
  console.log(`wallet ${W}`);
  console.log(`tokens acquired in ${WINDOW} blocks: ${firstSeen.size}, resolving creators for ${tokens.length}\n`);

  const creators = new Map<string, number>();
  const factories = new Map<string, number>();
  let resolved = 0;
  for (const [token, blk] of tokens) {
    const info = await creatorOf(token, blk);
    if (!info) continue;
    resolved++;
    creators.set(info.creator, (creators.get(info.creator) ?? 0) + 1);
    factories.set(info.factory, (factories.get(info.factory) ?? 0) + 1);
  }

  const rank = [...creators.entries()].sort((a, b) => b[1] - a[1]);
  const repeats = rank.filter(([, n]) => n > 1);
  const fromRepeat = repeats.reduce((s, [, n]) => s + n, 0);

  console.log(`resolved ${resolved} creators`);
  console.log(`  distinct creators        : ${creators.size}`);
  console.log(`  creators he bought twice+: ${repeats.length}`);
  console.log(`  his buys from those      : ${fromRepeat}/${resolved} (${((100 * fromRepeat) / Math.max(1, resolved)).toFixed(0)}%)`);
  if (repeats.length) {
    console.log(`\n  most repeated creators:`);
    for (const [addr, n] of repeats.slice(0, 8)) console.log(`    ${n}x ${addr}`);
  }

  console.log(`\n  launchpad factories he buys through:`);
  for (const [f, n] of [...factories.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(3)}x ${f || "(contract creation)"}`);
  }

  /*
   * Control. If creators on this chain launch many tokens each, then his list
   * repeating is what any random selection would look like, and it is not a
   * rule he is following.
   */
  console.log(`\n  CONTROL: how often creators repeat across ALL launches nearby`);
  const sample = new Map<string, number>();
  const lo = head - 4_000n;
  const mints = await c.getLogs({ event: XFER, args: { from: ZERO }, fromBlock: lo, toBlock: head }).catch(() => []);
  const uniq = [...new Set(mints.map((l) => `${l.transactionHash}`))].slice(0, 60);
  for (const h of uniq) {
    const tx = await c.getTransaction({ hash: h as `0x${string}` }).catch(() => null);
    if (!tx) continue;
    const k = String(tx.from).toLowerCase();
    sample.set(k, (sample.get(k) ?? 0) + 1);
  }
  const cRepeat = [...sample.values()].filter((n) => n > 1);
  const cFrom = cRepeat.reduce((s, n) => s + n, 0);
  const cTotal = [...sample.values()].reduce((s, n) => s + n, 0);
  console.log(`    sampled ${cTotal} launches from ${sample.size} creators`);
  console.log(`    launches by a repeat creator: ${cFrom}/${cTotal} (${((100 * cFrom) / Math.max(1, cTotal)).toFixed(0)}%)`);
}

main().catch((e) => console.log("ERR", String(e).slice(0, 250)));
