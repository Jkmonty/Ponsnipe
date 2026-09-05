/**
 * Study one wallet's trading, and whether following it is tradeable by us.
 *
 * Attribution is via Transfer, whose from/to are indexed, rather than the V4
 * Swap event, whose `sender` is the router contract and not the person.
 * Prices come from the pool's own sqrtPriceX96 on every swap, so the path is
 * the pool's actual history rather than an estimate.
 *
 *   npx tsx scripts/walletstudy.ts [wallet] [windowBlocks] [maxTokens]
 */
process.loadEnvFile?.(".env");
import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import { robinhoodChain } from "../src/lib/chain";

const W = (process.argv[2] ?? "0x4f1daedbc131458af1d7515b597ab398dee57fab").toLowerCase() as Address;
const WINDOW = BigInt(process.argv[3] ?? "400000");
const MAX_TOKENS = Number(process.argv[4] ?? 40);

const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as const;
const XFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const INIT = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
);
const SWAP = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);
const SEC_PER_BLOCK = 0.101;

const c = createPublicClient({
  chain: robinhoodChain,
  transport: http(process.env.LOGS_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", {
    retryCount: 3,
    timeout: 40_000,
  }),
});

const pct = (a: number, b: number) => ((b - a) / a) * 100;
function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}
const summary = (xs: number[]) =>
  `median ${quantile(xs, 0.5).toFixed(1)}%  mean ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)}%`;

interface Row {
  token: string;
  entryDelay: number;
  hold: number;
  his: number;
  peakWhileHeld: number;
  afterHisExit: number;
  copySlip: number | null;
  copyPeak: number | null;
}

async function main() {
  const head = await c.getBlockNumber();
  const start = head - WINDOW;

  type Ev = { token: string; block: bigint; dir: "in" | "out" };
  const evs: Ev[] = [];
  for (let b = start; b <= head; b += 50_000n) {
    const hi = b + 49_999n > head ? head : b + 49_999n;
    const [ins, outs] = await Promise.all([
      c.getLogs({ event: XFER, args: { to: W }, fromBlock: b, toBlock: hi }).catch(() => []),
      c.getLogs({ event: XFER, args: { from: W }, fromBlock: b, toBlock: hi }).catch(() => []),
    ]);
    for (const l of ins) evs.push({ token: String(l.address).toLowerCase(), block: l.blockNumber!, dir: "in" });
    for (const l of outs) evs.push({ token: String(l.address).toLowerCase(), block: l.blockNumber!, dir: "out" });
  }

  const byTok = new Map<string, Ev[]>();
  for (const e of evs) {
    const arr = byTok.get(e.token);
    if (arr) arr.push(e);
    else byTok.set(e.token, [e]);
  }

  const trips = [...byTok.entries()]
    .map(([token, a]) => {
      const ins = a.filter((x) => x.dir === "in").sort((p, q) => Number(p.block - q.block));
      const outs = a.filter((x) => x.dir === "out").sort((p, q) => Number(p.block - q.block));
      return { token, entry: ins[0]?.block, exit: outs[outs.length - 1]?.block };
    })
    .filter((t) => t.entry !== undefined && t.exit !== undefined && t.exit >= t.entry)
    .sort((a, b) => Number(b.entry! - a.entry!))
    .slice(0, MAX_TOKENS);

  console.log(`wallet ${W}`);
  console.log(
    `window ${WINDOW} blocks (~${((Number(WINDOW) * SEC_PER_BLOCK) / 3600).toFixed(1)}h) | ${byTok.size} tokens touched | studying ${trips.length}`,
  );

  const rows: Row[] = [];
  for (const t of trips) {
    const entry = t.entry!;
    const exit = t.exit!;

    // The pool this token trades in, and the block it opened.
    let init: { blockNumber: bigint; topics: readonly string[]; args: Record<string, unknown> } | undefined;
    for (let back = 0n; back < 120_000n && !init; back += 20_000n) {
      const hi = entry - back;
      const lo = hi - 19_999n < 0n ? 0n : hi - 19_999n;
      const found = await c.getLogs({ address: PM, event: INIT, fromBlock: lo, toBlock: hi }).catch(() => []);
      const mine = found.filter((l) => {
        const a = l.args as { currency0?: string; currency1?: string };
        return (
          String(a.currency0).toLowerCase() === t.token || String(a.currency1).toLowerCase() === t.token
        );
      });
      if (mine.length) {
        const l = mine[mine.length - 1];
        init = { blockNumber: l.blockNumber!, topics: l.topics, args: l.args as Record<string, unknown> };
      }
    }
    if (!init) continue;

    const poolId = String(init.topics[1]) as `0x${string}`;
    const tokenIsC1 = String(init.args.currency1).toLowerCase() === t.token;

    const to = exit + 3_000n > head ? head : exit + 3_000n;
    const path: { b: bigint; p: number }[] = [];
    for (let b = init.blockNumber; b <= to; b += 20_000n) {
      const hi = b + 19_999n > to ? to : b + 19_999n;
      const lg = await c.getLogs({ event: SWAP, args: { id: poolId }, fromBlock: b, toBlock: hi }).catch(() => []);
      for (const l of lg) {
        const sp = Number((l.args as { sqrtPriceX96?: bigint }).sqrtPriceX96 ?? 0n) / 2 ** 96;
        if (!(sp > 0)) continue;
        const p = tokenIsC1 ? 1 / (sp * sp) : sp * sp;
        if (Number.isFinite(p) && p > 0) path.push({ b: l.blockNumber!, p });
      }
    }
    if (path.length < 3) continue;
    path.sort((a, b) => Number(a.b - b.b));

    const priceAt = (blk: bigint) => {
      let last = path[0].p;
      for (const s of path) {
        if (s.b > blk) break;
        last = s.p;
      }
      return last;
    };

    const pEntry = priceAt(entry);
    const pExit = priceAt(exit);
    if (!(pEntry > 0) || !(pExit > 0)) continue;

    const held = path.filter((s) => s.b >= entry && s.b <= exit).map((s) => s.p);
    const peak = held.length ? Math.max(...held, pEntry) : pEntry;
    const tail = path.filter((s) => s.b > exit && s.b <= exit + 3_000n).map((s) => s.p);

    // Copying: we cannot act in his block, so enter ~5s (50 blocks) later.
    const copyBlk = entry + 50n;
    const pCopy = priceAt(copyBlk);
    const copyWindow = path.filter((s) => s.b >= copyBlk && s.b <= copyBlk + 3_000n).map((s) => s.p);

    rows.push({
      token: t.token,
      entryDelay: Number(entry - init.blockNumber) * SEC_PER_BLOCK,
      hold: Number(exit - entry) * SEC_PER_BLOCK,
      his: pct(pEntry, pExit),
      peakWhileHeld: pct(pEntry, peak),
      afterHisExit: pct(pExit, tail.length ? tail[tail.length - 1] : pExit),
      copySlip: pCopy > 0 ? pct(pEntry, pCopy) : null,
      copyPeak: pCopy > 0 ? pct(pCopy, copyWindow.length ? Math.max(...copyWindow, pCopy) : pCopy) : null,
    });
  }

  if (!rows.length) {
    console.log("no measurable trades");
    return;
  }

  const his = rows.map((r) => r.his);
  const cp = rows.filter((r) => r.copySlip !== null);
  console.log(`\nmeasured ${rows.length} round trips`);
  console.log(`\nHIS TIMING`);
  console.log(
    `  buys this long after the pool opens : median ${quantile(rows.map((r) => r.entryDelay), 0.5).toFixed(0)}s  p90 ${quantile(rows.map((r) => r.entryDelay), 0.9).toFixed(0)}s`,
  );
  console.log(
    `  holds for                           : median ${quantile(rows.map((r) => r.hold), 0.5).toFixed(0)}s  p90 ${quantile(rows.map((r) => r.hold), 0.9).toFixed(0)}s`,
  );
  console.log(`\nHIS RESULT (pool price, his entry -> his exit)`);
  console.log(`  ${summary(his)}   win rate ${((100 * his.filter((x) => x > 0).length) / his.length).toFixed(0)}%`);
  console.log(`  best that was available while he held : ${summary(rows.map((r) => r.peakWhileHeld))}`);
  console.log(`\nAFTER HE SELLS (next ~5 min)`);
  console.log(
    `  ${summary(rows.map((r) => r.afterHisExit))}   kept rising in ${((100 * rows.filter((r) => r.afterHisExit > 0).length) / rows.length).toFixed(0)}% of cases`,
  );
  console.log(`\nCOPYING HIM (we buy ~5s after he does)`);
  console.log(`  what the 5s delay costs us          : ${summary(cp.map((r) => r.copySlip!))}`);
  console.log(`  best exit available to us afterwards : ${summary(cp.map((r) => r.copyPeak!))}`);
  const copyable = cp.filter((r) => r.copyPeak! > 20).length;
  console.log(
    `  trades where >20% was still on offer : ${copyable}/${cp.length} (${((100 * copyable) / cp.length).toFixed(0)}%)`,
  );
}

main().catch((e) => console.log("ERR", String(e).slice(0, 250)));
