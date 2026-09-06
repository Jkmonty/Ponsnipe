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
 * A 20,000-block run answered half the question: every hold band from seconds
 * to an hour lost money, and profitable wallets held *shorter* than
 * unprofitable ones. It could not answer the other half, because a 34-minute
 * window cannot contain a trade held for a day. Hence the multi-day mode, and
 * hence the censoring correction below, which is the thing that makes a long
 * window honest rather than merely bigger.
 *
 * Returns are computed per round trip as received/spent in the curve's own
 * quote asset. That ratio is unit-free, so a curve quoted in USDG and one in
 * NVDA are directly comparable without knowing either asset's decimals.
 *
 *   npx tsx scripts/walletrank.ts [windowBlocks] [minTrips]
 *   npx tsx scripts/walletrank.ts 2570000 4     # ~3 days
 */
process.loadEnvFile?.(".env");
import { createPublicClient, fallback, http, parseAbiItem, type Log } from "viem";
import { robinhoodChain } from "../src/lib/chain";

const WINDOW = BigInt(process.argv[2] ?? "20000");
const MIN_TRIPS = Number(process.argv[3] ?? 4);
const CHUNK = 1_000n;
/** Replaced at startup by the real rate, measured from block timestamps. */
let secPerBlock = 0.101;
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
 * Failed chunks are retried, not just counted. At the ~5% failure rate a short
 * run showed, a multi-day sweep would otherwise quietly drop tens of thousands
 * of trades, and a gap that size can invent a trend on its own.
 */
const RETRY_PASSES = 3;
/** Print the tables this often, so a long run yields results before it ends. */
const INTERIM_EVERY = 250;

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
const LOG_POOL = ["https://rpc.ordofi.network", "https://rpc.mainnet.chain.robinhood.com"];

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
const hms = (s: number) =>
  s >= 3600 ? `${(s / 3600).toFixed(1)}h` : s >= 60 ? `${(s / 60).toFixed(1)}m` : `${s.toFixed(0)}s`;

interface Trip {
  wallet: string;
  ret: number;
  holdSec: number;
  /** Kept so a band can exclude trips that entered too late to be seen. */
  entry: bigint;
}

/**
 * Hold bands, with the upper edge each one needs in order to be observable.
 *
 * This is the correction a multi-day window demands. A trade held for a day is
 * only visible if it *started* at least a day before the head, so counting
 * every band over the same block range systematically under-samples the long
 * holds — and under-samples them worst at the right-hand edge, where the
 * unfinished winners live. Each band is therefore measured only over trips
 * that entered early enough for a hold of that length to have completed. The
 * open-ended top band uses its lower edge, and stays biased no matter what;
 * that is a limit of a finite window, not something arithmetic can fix.
 */
const BANDS: [label: string, lo: number, hi: number][] = [
  ["under 30s", 0, 30],
  ["30s - 2m", 30, 120],
  ["2m - 10m", 120, 600],
  ["10m - 1h", 600, 3600],
  ["1h - 6h", 3600, 21_600],
  ["6h - 24h", 21_600, 86_400],
  ["over 24h", 86_400, Infinity],
];

function report(trips: Trip[], head: bigint, minTrips: number, openPositions: number): void {
  if (!trips.length) {
    console.log("no completed round trips yet");
    return;
  }

  console.log("\nHOLD TIME vs RETURN");
  console.log(
    `  ${"band".padEnd(11)} ${"n".padStart(7)} ${"median".padStart(9)} ${"mean".padStart(10)} ${"win%".padStart(6)}`,
  );
  for (const [label, lo, hi] of BANDS) {
    // Only trips that entered early enough for this hold length to complete.
    const need = Number.isFinite(hi) ? hi : 86_400;
    const cutoff = head - BigInt(Math.ceil(need / secPerBlock));
    const set = trips
      .filter((t) => t.entry <= cutoff)
      .filter((t) => t.holdSec >= lo && t.holdSec < hi)
      .map((t) => t.ret);
    if (!set.length) continue;
    const win = (100 * set.filter((r) => r > 0).length) / set.length;
    console.log(
      `  ${label.padEnd(11)} ${String(set.length).padStart(7)} ${quantile(set, 0.5).toFixed(1).padStart(8)}% ${mean(set).toFixed(1).padStart(9)}% ${win.toFixed(0).padStart(5)}%`,
    );
  }

  const byWallet = new Map<string, Trip[]>();
  for (const t of trips) {
    const a = byWallet.get(t.wallet);
    if (a) a.push(t);
    else byWallet.set(t.wallet, [t]);
  }
  const ranked = [...byWallet.entries()]
    .filter(([, ts]) => ts.length >= minTrips)
    .map(([w, ts]) => ({
      wallet: w,
      trips: ts.length,
      medianRet: quantile(
        ts.map((t) => t.ret),
        0.5,
      ),
      win: (100 * ts.filter((t) => t.ret > 0).length) / ts.length,
      medianHold: quantile(
        ts.map((t) => t.holdSec),
        0.5,
      ),
    }))
    .sort((a, b) => b.medianRet - a.medianRet);

  console.log(
    `\n${trips.length} completed round trips, ${openPositions} positions never sold ` +
      `(${((100 * openPositions) / (openPositions + trips.length)).toFixed(0)}% still open)`,
  );
  console.log(`WALLETS with ${minTrips}+ completed round trips: ${ranked.length}`);
  if (!ranked.length) return;

  console.log(`\n  best by median return`);
  console.log(
    `  ${"wallet".padEnd(14)} ${"trips".padStart(5)} ${"median".padStart(9)} ${"win%".padStart(6)} ${"hold".padStart(8)}`,
  );
  for (const r of ranked.slice(0, 12)) {
    console.log(
      `  ${r.wallet.slice(0, 12).padEnd(14)} ${String(r.trips).padStart(5)} ${r.medianRet.toFixed(1).padStart(8)}% ${r.win.toFixed(0).padStart(5)}% ${hms(r.medianHold).padStart(8)}`,
    );
  }
  const all = ranked.map((r) => r.medianRet);
  console.log(
    `\n  across all ${ranked.length} such wallets: median ${quantile(all, 0.5).toFixed(1)}%, mean ${mean(all).toFixed(1)}%`,
  );
  console.log(`  profitable on median: ${ranked.filter((r) => r.medianRet > 0).length}/${ranked.length}`);

  // The question lesson one actually asks: do the good ones hold longer?
  const good = ranked.filter((r) => r.medianRet > 0).map((r) => r.medianHold);
  const bad = ranked.filter((r) => r.medianRet <= 0).map((r) => r.medianHold);
  if (good.length && bad.length) {
    console.log(
      `\n  median hold, profitable wallets: ${hms(quantile(good, 0.5))}   unprofitable: ${hms(quantile(bad, 0.5))}`,
    );
  }
  // And the same question asked of the trades rather than the wallets.
  const winners = trips.filter((t) => t.ret > 0).map((t) => t.holdSec);
  const losers = trips.filter((t) => t.ret <= 0).map((t) => t.holdSec);
  if (winners.length && losers.length) {
    console.log(
      `  median hold, winning trades:     ${hms(quantile(winners, 0.5))}   losing:       ${hms(quantile(losers, 0.5))}`,
    );
  }
}

async function main() {
  const head = await c.getBlockNumber();
  const from = head - WINDOW;

  // Measure the block rate rather than assuming it. Over a multi-day window a
  // wrong constant would shift every trade into the wrong hold band.
  try {
    const [a, b] = await Promise.all([c.getBlock({ blockNumber: from }), c.getBlock({ blockNumber: head })]);
    const dt = Number(b.timestamp - a.timestamp) / Number(head - from);
    if (dt > 0.01 && dt < 60) secPerBlock = dt;
  } catch {
    /* keep the default */
  }
  console.log(
    `scanning ${WINDOW} blocks to head ${head}\n` +
      `block time measured at ${secPerBlock.toFixed(4)}s, so the window is ~${(
        (Number(WINDOW) * secPerBlock) /
        86400
      ).toFixed(2)} days`,
  );

  /** (wallet|curve) -> the legs of that position. */
  const legs = new Map<string, Leg>();
  let scanned = 0;
  let done = 0;

  let pending: [bigint, bigint][] = [];
  for (let b = from; b <= head; b += CHUNK) {
    pending.push([b, b + CHUNK - 1n > head ? head : b + CHUNK - 1n]);
  }
  const total = pending.length;
  const started = Date.now();

  function absorb(logs: Awaited<ReturnType<typeof c.getLogs>>): void {
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
        // Chunks land out of order, so take the extremes rather than trusting
        // arrival order the way a serial sweep could.
        if (e.firstBuy === 0n || blk < e.firstBuy) e.firstBuy = blk;
      } else {
        e.received += Number(a.quoteOut ?? 0n);
        e.sells += 1;
        if (blk > e.lastSell) e.lastSell = blk;
      }
      legs.set(key, e);
    }
  }

  function snapshot(): { trips: Trip[]; open: number } {
    const trips: Trip[] = [];
    let open = 0;
    for (const [key, e] of legs) {
      if (e.spent <= 0) continue;
      if (e.sells === 0 || e.lastSell <= e.firstBuy) {
        open += 1;
        continue;
      }
      trips.push({
        wallet: key.split("|")[0],
        ret: ((e.received - e.spent) / e.spent) * 100,
        holdSec: Number(e.lastSell - e.firstBuy) * secPerBlock,
        entry: e.firstBuy,
      });
    }
    return { trips, open };
  }

  for (let pass = 0; pass <= RETRY_PASSES && pending.length; pass++) {
    if (pass > 0) {
      console.log(`\nretry pass ${pass}: ${pending.length} chunks that failed`);
    }
    const queue = pending;
    const failed: [bigint, bigint][] = [];
    let next = 0;

    async function worker(): Promise<void> {
      for (;;) {
        const i = next++;
        if (i >= queue.length) return;
        const [lo, hi] = queue[i];
        const logs = await withTimeout(
          c.getLogs({ events: [BUY, SELL], fromBlock: lo, toBlock: hi }),
          CHUNK_TIMEOUT_MS,
        );
        if (!logs) failed.push([lo, hi]);
        else absorb(logs);

        if (pass === 0) {
          done += 1;
          if (done % 25 === 0 || done === total) {
            const el = (Date.now() - started) / 1000;
            console.log(
              `  ${done}/${total} chunks  ${scanned} trades  ${failed.length} failed  ` +
                `${(el / 60).toFixed(1)}m elapsed  ~${(((el / done) * (total - done)) / 60).toFixed(1)}m left`,
            );
          }
          // Partial results beat none if a long run dies halfway.
          if (done % INTERIM_EVERY === 0) {
            const { trips, open } = snapshot();
            console.log(`\n──── interim, ${done}/${total} chunks ────`);
            report(trips, head, MIN_TRIPS, open);
            console.log(`──── end interim ────\n`);
          }
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    pending = failed;
  }

  const { trips, open } = snapshot();
  console.log(
    `\n${scanned} trades, ${legs.size} wallet-token positions` +
      (pending.length
        ? `  (${pending.length}/${total} chunks never answered after ${RETRY_PASSES} retries — coverage is partial)`
        : `  (every chunk answered)`),
  );
  console.log(`sweep took ${((Date.now() - started) / 60_000).toFixed(1)} minutes`);
  report(trips, head, MIN_TRIPS, open);
}

main().catch((e) => console.log("ERR", String(e).slice(0, 250)));
