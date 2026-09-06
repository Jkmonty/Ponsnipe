/**
 * Rank wallets by what they actually made on pons curves, and test whether
 * holding longer pays.
 *
 * Lesson one of the note you were sent is "find wallets that consistently catch
 * early entries and hold, avoid the pump-and-dump actors", and lesson two is
 * "get in early, stay put". Both are claims about a correlation between hold
 * time and return, and both are testable here rather than taken on faith — the
 * one wallet we studied by hand held for a median of 42 seconds and made 11%,
 * which is exactly the actor lesson one says to avoid.
 *
 * Returns are computed per round trip as received/spent in the curve's own
 * quote asset. That ratio is unit-free, so a curve quoted in USDG and one in
 * NVDA are directly comparable without knowing either asset's decimals.
 *
 *   npx tsx scripts/walletrank.ts [windowBlocks] [minTrips]
 */
process.loadEnvFile?.(".env");
import { createPublicClient, fallback, http, parseAbiItem, type Log } from "viem";
import { robinhoodChain } from "../src/lib/chain";

const WINDOW = BigInt(process.argv[2] ?? "20000");
const MIN_TRIPS = Number(process.argv[3] ?? 4);
const CHUNK = 1_000n;
const SEC_PER_BLOCK = 0.101;
/**
 * A stalled socket is the failure that matters here. The transport timeout did
 * not save the first run of this script: it sat for 2h54m on 16 seconds of CPU,
 * blocked on a request that never returned and never threw, and never printed
 * a line. Every chunk now races a hard timer, so a wedged endpoint costs one
 * chunk instead of the whole run.
 */
const CHUNK_TIMEOUT_MS = 25_000;
/** Chunks in flight, across two usable endpoints. */
const CONCURRENCY = 4;

/**
 * Only two of the four public endpoints will serve a chain-wide getLogs.
 * Measured over 1,000-block topic-filtered spans:
 *
 *   rpc.mainnet.chain.robinhood.com   207ms / 1.6s / 9.4s, one failure in three
 *   rpc.ordofi.network                4.4s / 3.9s / 5.1s, no failures
 *   robinhood-rpc.publicnode.com      fails in ~85ms
 *   rpc.arrowrpc.com                  fails in ~119ms
 *
 * The two that fail do so fast, which is the dangerous part: an earlier version
 * of this script caught the failure per chunk and carried on, so half the chain
 * would have gone missing and the tables would still have looked confident.
 * Sweeping only the endpoints that answer means a gap is a real gap.
 */
const LOG_POOL = [
  "https://rpc.ordofi.network",
  "https://rpc.mainnet.chain.robinhood.com",
];

const BUY = parseAbiItem(
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
);
const SELL = parseAbiItem(
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
);

const c = createPublicClient({
  chain: robinhoodChain,
  transport: fallback(
    LOG_POOL.map((u) => http(u, { retryCount: 1, timeout: 25_000 })),
    { retryCount: 0, rank: { interval: 30_000, sampleCount: 3 } },
  ),
});

/** Resolve to null rather than hang, whatever the promise does. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

interface Leg {
  spent: number;
  received: number;
  firstBuy: bigint;
  lastSell: bigint;
  buys: number;
  sells: number;
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

async function main() {
  const head = await c.getBlockNumber();
  const from = head - WINDOW;
  console.log(
    `scanning ${WINDOW} blocks (~${((Number(WINDOW) * SEC_PER_BLOCK) / 3600).toFixed(1)}h) to head ${head}`,
  );

  /** (wallet|curve) -> the legs of that position. */
  const legs = new Map<string, Leg>();
  let scanned = 0;
  let failed = 0;
  let done = 0;

  const ranges: [bigint, bigint][] = [];
  for (let b = from; b <= head; b += CHUNK) {
    ranges.push([b, b + CHUNK - 1n > head ? head : b + CHUNK - 1n]);
  }
  const started = Date.now();
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= ranges.length) return;
      const [lo, hi] = ranges[i];
      const logs = await withTimeout(
        c.getLogs({ events: [BUY, SELL], fromBlock: lo, toBlock: hi }),
        CHUNK_TIMEOUT_MS,
      );
      done += 1;
      if (!logs) {
        // Counted, not swallowed: a run that silently missed half the chain
        // would still print a confident-looking table.
        failed += 1;
      } else {
        scanned += logs.length;
        for (const l of logs as (Log & { eventName?: string; args?: unknown })[]) {
          const isBuy = l.eventName === "CurveBuy";
          const a = (l.args ?? {}) as {
            buyer?: string;
            seller?: string;
            quoteIn?: bigint;
            quoteOut?: bigint;
          };
          const who = String((isBuy ? a.buyer : a.seller) ?? "").toLowerCase();
          if (!who) continue;
          const key = `${who}|${String(l.address).toLowerCase()}`;
          const e =
            legs.get(key) ??
            ({ spent: 0, received: 0, firstBuy: 0n, lastSell: 0n, buys: 0, sells: 0 } as Leg);
          const blk = l.blockNumber ?? 0n;
          if (isBuy) {
            e.spent += Number(a.quoteIn ?? 0n);
            e.buys += 1;
            // Chunks land out of order now, so take the extremes rather than
            // trusting arrival order the way the serial version could.
            if (e.firstBuy === 0n || blk < e.firstBuy) e.firstBuy = blk;
          } else {
            e.received += Number(a.quoteOut ?? 0n);
            e.sells += 1;
            if (blk > e.lastSell) e.lastSell = blk;
          }
          legs.set(key, e);
        }
      }
      if (done % 5 === 0 || done === ranges.length) {
        const el = (Date.now() - started) / 1000;
        const eta = (el / done) * (ranges.length - done);
        console.log(
          `  ${done}/${ranges.length} chunks  ${scanned} trades  ${failed} failed  ${el.toFixed(0)}s elapsed  ~${eta.toFixed(0)}s left`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(
    `\n${scanned} trades, ${legs.size} wallet-token positions` +
      (failed ? `  (${failed}/${ranges.length} chunks failed, coverage is partial)` : ""),
  );

  /** Completed round trips only: an open position has no realised number. */
  interface Trip {
    wallet: string;
    ret: number;
    holdSec: number;
  }
  const trips: Trip[] = [];
  for (const [key, e] of legs) {
    if (e.spent <= 0 || e.sells === 0 || e.lastSell <= e.firstBuy) continue;
    trips.push({
      wallet: key.split("|")[0],
      ret: ((e.received - e.spent) / e.spent) * 100,
      holdSec: Number(e.lastSell - e.firstBuy) * SEC_PER_BLOCK,
    });
  }
  if (!trips.length) {
    console.log("no completed round trips in this window");
    return;
  }

  // ── Does holding longer pay? ──────────────────────────────────────────────
  const bands: [string, (t: Trip) => boolean][] = [
    ["under 30s", (t) => t.holdSec < 30],
    ["30s - 2m", (t) => t.holdSec >= 30 && t.holdSec < 120],
    ["2m - 10m", (t) => t.holdSec >= 120 && t.holdSec < 600],
    ["10m - 1h", (t) => t.holdSec >= 600 && t.holdSec < 3600],
    ["over 1h", (t) => t.holdSec >= 3600],
  ];
  console.log("\nHOLD TIME vs RETURN  (every completed round trip in the window)");
  console.log(
    `  ${"band".padEnd(11)} ${"n".padStart(6)} ${"median".padStart(9)} ${"mean".padStart(9)} ${"win%".padStart(7)}`,
  );
  for (const [label, pick] of bands) {
    const set = trips.filter(pick).map((t) => t.ret);
    if (!set.length) continue;
    const win = (100 * set.filter((r) => r > 0).length) / set.length;
    console.log(
      `  ${label.padEnd(11)} ${String(set.length).padStart(6)} ${quantile(set, 0.5).toFixed(1).padStart(8)}% ${mean(set).toFixed(1).padStart(8)}% ${win.toFixed(0).padStart(6)}%`,
    );
  }

  // ── The wallets themselves ────────────────────────────────────────────────
  const byWallet = new Map<string, Trip[]>();
  for (const t of trips) {
    const a = byWallet.get(t.wallet);
    if (a) a.push(t);
    else byWallet.set(t.wallet, [t]);
  }
  const ranked = [...byWallet.entries()]
    .filter(([, ts]) => ts.length >= MIN_TRIPS)
    .map(([w, ts]) => ({
      wallet: w,
      trips: ts.length,
      medianRet: quantile(
        ts.map((t) => t.ret),
        0.5,
      ),
      meanRet: mean(ts.map((t) => t.ret)),
      win: (100 * ts.filter((t) => t.ret > 0).length) / ts.length,
      medianHold: quantile(
        ts.map((t) => t.holdSec),
        0.5,
      ),
    }))
    .sort((a, b) => b.medianRet - a.medianRet);

  console.log(`\nWALLETS with ${MIN_TRIPS}+ completed round trips: ${ranked.length}`);
  if (ranked.length) {
    console.log(`\n  best by median return`);
    console.log(
      `  ${"wallet".padEnd(14)} ${"trips".padStart(5)} ${"median".padStart(8)} ${"win%".padStart(6)} ${"hold".padStart(8)}`,
    );
    for (const r of ranked.slice(0, 12)) {
      console.log(
        `  ${r.wallet.slice(0, 12).padEnd(14)} ${String(r.trips).padStart(5)} ${r.medianRet.toFixed(1).padStart(7)}% ${r.win.toFixed(0).padStart(5)}% ${r.medianHold.toFixed(0).padStart(7)}s`,
      );
    }
    const all = ranked.map((r) => r.medianRet);
    console.log(
      `\n  across all ${ranked.length} such wallets: median ${quantile(all, 0.5).toFixed(1)}%, mean ${mean(all).toFixed(1)}%`,
    );
    console.log(
      `  profitable on median: ${ranked.filter((r) => r.medianRet > 0).length}/${ranked.length}`,
    );
    // The question lesson one actually asks: do the good ones hold longer?
    const good = ranked.filter((r) => r.medianRet > 0).map((r) => r.medianHold);
    const bad = ranked.filter((r) => r.medianRet <= 0).map((r) => r.medianHold);
    if (good.length && bad.length) {
      console.log(
        `\n  median hold, profitable wallets: ${quantile(good, 0.5).toFixed(0)}s   unprofitable: ${quantile(bad, 0.5).toFixed(0)}s`,
      );
    }
  }
}

main().catch((e) => console.log("ERR", String(e).slice(0, 250)));
