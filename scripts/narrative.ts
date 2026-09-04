/**
 * Replay one real narrative: every token that launched with a given ticker, and
 * what each exit rule would have made.
 *
 *   npm run narrative -- --ticker CONCERN
 *   npm run narrative -- --ticker CONCERN --hours 24 --eth 0.01
 *
 * The 5-day scan is history; a narrative that broke today is not in it. This
 * finds the wave live, rebuilds each member's curve from its own events, and
 * scores the strategies against it — including the one the sweep never tested.
 *
 * THE FREE-RIDE EXIT, which is Jake's idea and genuinely different: rather than
 * selling the whole position at a target, sell just enough to take the original
 * stake back, then hold the remainder at zero risk. At a 2x you sell half and
 * ride the rest for free. It cannot lose money once triggered, and it cannot
 * capture as much as holding, so the question is whether the tokens that reach
 * the trigger run far enough afterwards to pay for the ones that never do.
 *
 * Reads only. Nothing is signed.
 */
try {
  process.loadEnvFile?.(".env");
} catch {
  /* ignore */
}

import {
  createPublicClient,
  http,
  parseAbiItem,
  parseEventLogs,
  keccak256,
  toHex,
  parseEther,
  type Address,
} from "viem";
import { robinhoodChain } from "../src/lib/chain";
import { bondingCurveAbi, erc20Abi } from "../src/lib/pons/abis";
import { quoteBuy, quoteSell, priceFromReserves, type CurveReserves } from "../src/lib/pons/pricing";

const RPC = process.env.BACKTEST_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as Address;
const NATIVE = "0x0000000000000000000000000000000000000000";
const SUPPLY = 10n ** 27n;
/**
 * The seeded phantom reserve is 1.68 ETH on native curves but scales with the
 * launch config, so a curve quoted in SPCX or USDG has a different one.
 * Assuming the native value for those makes both liquidity and graduation
 * wrong, so it is derived per curve from that curve's own first buy.
 *
 * Constant product: phantom * SUPPLY = (phantom + net) * (SUPPLY - tokensOut),
 * which rearranges to phantom = net * (SUPPLY - tokensOut) / tokensOut.
 */
function derivePhantom(net: bigint, tokensOut: bigint): bigint {
  if (tokensOut <= 0n || tokensOut >= SUPPLY || net <= 0n) return 0n;
  return (net * (SUPPLY - tokensOut)) / tokensOut;
}
const FEE_BPS = 100n;
const LOG_CHUNK = 2000n;
const SYM_BATCH = 200;

function argStr(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
function argNum(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const n = i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(n) ? n : dflt;
}
const TICKER = argStr("ticker", "").toLowerCase().replace(/[^a-z0-9]/g, "");
const HOURS = argNum("hours", 24);
const ETH_IN = parseEther(String(argNum("eth", 0.01)));
const RPS = argNum("rps", 3);
const DELAY_SECONDS = argNum("delay", 20);
/**
 * Position size as a FRACTION OF THE GRADUATION THRESHOLD, not a fixed amount.
 *
 * Quote tokens differ in decimals — SPCX is 18, others are 6 — so spending a
 * fixed raw amount means a sane bite out of one curve and ten billion tokens
 * out of another. Sizing against each curve's own threshold takes the same
 * proportional bite everywhere, needs no decimals and no price feed, and keeps
 * returns comparable across ETH-, stock- and stablecoin-quoted launches.
 * 0.01 ETH into a 4.2 ETH native curve is the reference.
 */
const STAKE_FRACTION = Number(ETH_IN) / 4.2e18;

if (!TICKER) {
  console.error("\nUsage: npm run narrative -- --ticker CONCERN [--hours 24]\n");
  process.exit(1);
}

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(RPC, { retryCount: 2, timeout: 30_000 }),
});
const launchEvent = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
);
const T0_BUY = keccak256(toHex("CurveBuy(address,address,uint256,uint256,uint256,uint256)"));
const T0_SELL = keccak256(toHex("CurveSell(address,address,uint256,uint256,uint256,uint256)"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MIN_INTERVAL = 1000 / Math.max(0.5, RPS);
let lastCall = 0;
let requests = 0;
async function rpc<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const wait = MIN_INTERVAL - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    requests++;
    try {
      return await fn();
    } catch (e) {
      const s = String(e);
      const retry =
        s.includes("429") || s.includes("403") || /too many requests|cf-mitigated|timed out|timeout/i.test(s);
      if (!retry || attempt >= 8) throw e;
      await sleep(Math.min(60_000, 2_000 * 2 ** attempt));
    }
  }
}

interface Member {
  token: string;
  curve: string;
  deployer: string;
  symbol: string;
  /** Zero address for ETH; otherwise a stock or stablecoin token. */
  pairToken: string;
  quoteSymbol: string;
  launchBlock: bigint;
  threshold: bigint;
}

/** One simulated exit rule applied to a rebuilt price path. */
interface Outcome {
  name: string;
  pnlPct: number;
  detail: string;
}

async function main() {
  const head = await rpc(() => client.getBlockNumber());
  const hb = await rpc(() => client.getBlock({ blockNumber: head }));
  const pb = await rpc(() => client.getBlock({ blockNumber: head - 50_000n }));
  const blockSecs = Number(hb.timestamp - pb.timestamp) / 50_000;
  const span = BigInt(Math.round((HOURS * 3600) / blockSecs));
  const start = head - span;
  const delayBlocks = BigInt(Math.max(1, Math.round(DELAY_SECONDS / blockSecs)));

  console.log(`\nnarrative replay — ticker "${TICKER}", last ${HOURS}h`);
  console.log(`blocks ${start} → ${head}, entry ${DELAY_SECONDS}s after launch, ${Number(ETH_IN) / 1e18} ETH\n`);

  // ── find every launch, then resolve symbols to find our wave ──────────────
  const launches: Member[] = [];
  const chunks = Number(span / LOG_CHUNK) + 1;
  let done = 0;
  for (let from = start; from <= head; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > head ? head : from + LOG_CHUNK - 1n;
    const lg = await rpc(() =>
      client.getLogs({ address: FACTORY, event: launchEvent, fromBlock: from, toBlock: to }),
    );
    for (const l of lg) {
      // Stock- and stablecoin-quoted launches are INCLUDED. They are most of
      // the market and the ones actually being traded, reached through a zap;
      // excluding them is what made every earlier result cover half the venue.
      launches.push({
        token: (l.args.token as string).toLowerCase(),
        curve: (l.args.curve as string).toLowerCase(),
        deployer: (l.args.deployer as string).toLowerCase(),
        symbol: "",
        pairToken: (l.args.pairToken as string).toLowerCase(),
        quoteSymbol: "",
        launchBlock: l.blockNumber!,
        threshold: l.args.graduationThreshold as bigint,
      });
    }
    done++;
    if (done % 20 === 0) process.stdout.write(`\r  scanning launches ${((done / chunks) * 100).toFixed(0)}%  found ${launches.length}   `);
  }
  const nat = launches.filter((m) => m.pairToken === NATIVE).length;
  console.log(
    `\r  ${launches.length} launches (${nat} ETH-quoted, ${launches.length - nat} stock/stable-quoted)          `,
  );

  const matches: Member[] = [];
  for (let i = 0; i < launches.length; i += SYM_BATCH) {
    const slice = launches.slice(i, i + SYM_BATCH);
    const res = await rpc(() =>
      client.multicall({
        contracts: slice.map((m) => ({ address: m.token as Address, abi: erc20Abi, functionName: "symbol" as const })),
        allowFailure: true,
      }),
    );
    for (let k = 0; k < slice.length; k++) {
      const r = res[k];
      if (r.status !== "success") continue;
      slice[k].symbol = String(r.result);
      if (String(r.result).toLowerCase().replace(/[^a-z0-9]/g, "") === TICKER) matches.push(slice[k]);
    }
    process.stdout.write(`\r  resolving symbols ${Math.min(i + SYM_BATCH, launches.length)}/${launches.length}, ${matches.length} matches   `);
  }
  console.log("");

  if (!matches.length) {
    console.log(`\nNo native-ETH token with ticker "${TICKER}" launched in the last ${HOURS}h.`);
    console.log(`It may be older, or quoted in a stock token rather than ETH.\n`);
    return;
  }

  // Name the quote token for each member: a wave can be split across ETH and
  // several stock tokens, and a return only means something against its quote.
  const quotes = [...new Set(matches.map((m) => m.pairToken))].filter((q) => q !== NATIVE);
  if (quotes.length) {
    const qres = await rpc(() =>
      client.multicall({
        contracts: quotes.map((q) => ({ address: q as Address, abi: erc20Abi, functionName: "symbol" as const })),
        allowFailure: true,
      }),
    );
    const qmap = new Map<string, string>();
    quotes.forEach((q, i) => qmap.set(q, qres[i].status === "success" ? String(qres[i].result) : q.slice(0, 8)));
    for (const m of matches) m.quoteSymbol = m.pairToken === NATIVE ? "ETH" : (qmap.get(m.pairToken) ?? "?");
  } else {
    for (const m of matches) m.quoteSymbol = "ETH";
  }

  matches.sort((a, b) => (a.launchBlock < b.launchBlock ? -1 : 1));
  const first = matches[0].launchBlock;
  console.log(`\n${matches.length} launches of "${matches[0].symbol}" — spread over ${((Number(matches[matches.length - 1].launchBlock - first) * blockSecs) / 60).toFixed(1)} min\n`);

  // ── rebuild each member's curve and score the exits ───────────────────────
  console.log(`  #   token          quote      launched   % to grad   peak x   graduated`);
  const perMember: { m: Member; outcomes: Outcome[] }[] = [];

  for (let idx = 0; idx < matches.length; idx++) {
    const m = matches[idx];
    // Same proportional bite on every curve, whatever it is quoted in.
    const stake = (m.threshold * BigInt(Math.round(STAKE_FRACTION * 1e9))) / 1_000_000_000n;
    let phantom = 0n;
    let quote = 0n;
    let tokens = SUPPLY;
    let taxBps: bigint | null = null;

    let entered = false;
    let held = 0n;
    let entryPrice = 0;
    let peakPrice = 0;
    let peakLiq = 0;
    let peakPctToGrad = 0;
    let graduated = false;

    // free-ride state: once the stake is recovered we ride the remainder
    let recovered = false;
    let recoveredEth = 0;
    let ridingTokens = 0n;

    // comparison rules
    let trailPeak = 0;
    let trailExit: number | null = null;
    let tpExit: number | null = null;

    const to = m.launchBlock + BigInt(Math.round((6 * 3600) / blockSecs)); // 6h of life
    for (let f = m.launchBlock; f <= to && f <= head; f += LOG_CHUNK) {
      const t = f + LOG_CHUNK - 1n > head ? head : f + LOG_CHUNK - 1n;
      const raw = (await rpc(() =>
        client.request({
          method: "eth_getLogs",
          params: [
            { address: m.curve as Address, fromBlock: `0x${f.toString(16)}`, toBlock: `0x${t.toString(16)}`, topics: [[T0_BUY, T0_SELL]] },
          ],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }),
      )) as any[];
      const evs = parseEventLogs({ abi: bondingCurveAbi, logs: raw });
      if (!evs.length && f > m.launchBlock + 20_000n) break; // gone quiet, stop paying for it

      for (const e of evs) {
        if (e.eventName !== "CurveBuy" && e.eventName !== "CurveSell") continue;
        const a = e.args as unknown as Record<string, bigint | string>;
        if (e.eventName === "CurveBuy") {
          const qin = a.quoteIn as bigint, fee = a.fee as bigint, tax = a.tax as bigint;
          if (taxBps === null && qin > 0n) taxBps = BigInt(Math.round(Number((tax * 10_000n) / qin) / 50) * 50);
          const net = qin - fee - tax;
          const out = a.tokensOut as bigint;
          // The curve's very first buy reveals its own seeded reserve, which
          // differs per launch config — 1.68 on ETH, far larger on a stock quote.
          if (phantom === 0n) {
            phantom = derivePhantom(net, out);
            quote = phantom;
          }
          quote += net > 0n ? net : 0n;
          tokens = tokens > out ? tokens - out : 0n;
        } else {
          const gross = (a.quoteOut as bigint) + (a.fee as bigint) + (a.tax as bigint);
          quote = quote > gross ? quote - gross : 0n;
          tokens += a.tokensIn as bigint;
        }
        if (quote <= 0n || tokens <= 0n) continue;

        const res: CurveReserves = { quoteReserve: quote, tokenReserve: tokens };
        const price = priceFromReserves(res, 18, 18).priceQuote;
        const realQuote = quote > phantom ? quote - phantom : 0n;
        const liq = Number(realQuote) / 1e18;
        if (liq > peakLiq) peakLiq = liq;
        const pctToGrad = m.threshold > 0n ? (Number(realQuote) / Number(m.threshold)) * 100 : 0;
        if (pctToGrad > peakPctToGrad) peakPctToGrad = pctToGrad;
        if (realQuote >= m.threshold) graduated = true;

        // enter once past the anti-snipe window
        if (!entered && e.blockNumber! >= m.launchBlock + delayBlocks) {
          const q = quoteBuy(stake, res, FEE_BPS, taxBps ?? 0n);
          if (q.tokensOut > 0n) {
            entered = true;
            held = q.tokensOut;
            ridingTokens = q.tokensOut;
            entryPrice = Number(stake) / Number(q.tokensOut);
            trailPeak = entryPrice;
          }
          continue;
        }
        if (!entered) continue;
        if (price > peakPrice) peakPrice = price;
        if (price > trailPeak) trailPeak = price;

        const mult = price / entryPrice;

        // FREE RIDE: at 2x, sell exactly enough to take the stake back.
        if (!recovered && mult >= 2) {
          // tokens worth roughly the original stake at the current price
          let sellTokens = BigInt(Math.floor(Number(stake) / price));
          if (sellTokens > ridingTokens) sellTokens = ridingTokens;
          const s = quoteSell(sellTokens, res, FEE_BPS, taxBps ?? 0n);
          recoveredEth = Number(s.quoteOut);
          ridingTokens -= sellTokens;
          recovered = true;
        }

        // trailing stop 25%, our best exit in the sweep
        if (trailExit === null && ((price - trailPeak) / trailPeak) * 100 <= -25) {
          const s = quoteSell(held, res, FEE_BPS, taxBps ?? 0n);
          trailExit = ((Number(s.quoteOut) - Number(stake)) / Number(stake)) * 100;
        }
        if (tpExit === null && mult >= 2) {
          const s = quoteSell(held, res, FEE_BPS, taxBps ?? 0n);
          tpExit = ((Number(s.quoteOut) - Number(stake)) / Number(stake)) * 100;
        }
      }
      if (graduated) break; // curve locks; nothing more to model here
    }

    const inEth = Number(stake);
    const finalRes: CurveReserves = { quoteReserve: quote, tokenReserve: tokens };
    const markOut = (amount: bigint) =>
      amount > 0n && quote > 0n && tokens > 0n
        ? Number(quoteSell(amount, finalRes, FEE_BPS, taxBps ?? 0n).quoteOut)
        : 0;

    const outcomes: Outcome[] = [];
    if (!entered) {
      outcomes.push({ name: "never entered", pnlPct: 0, detail: "no trade" });
    } else {
      outcomes.push({
        name: "hold to end",
        pnlPct: ((markOut(held) - inEth) / inEth) * 100,
        detail: "",
      });
      outcomes.push({
        name: "trail 25%",
        pnlPct: trailExit ?? ((markOut(held) - inEth) / inEth) * 100,
        detail: trailExit === null ? "never stopped out" : "stopped",
      });
      outcomes.push({
        name: "take profit 2x",
        pnlPct: tpExit ?? ((markOut(held) - inEth) / inEth) * 100,
        detail: tpExit === null ? "never hit 2x" : "hit",
      });
      outcomes.push({
        name: "free ride @2x",
        pnlPct: ((recoveredEth + markOut(ridingTokens) - inEth) / inEth) * 100,
        detail: recovered
          ? `recovered ${recoveredEth.toFixed(5)} ETH, rode ${((Number(ridingTokens) / Number(held)) * 100).toFixed(0)}%`
          : "never reached 2x",
      });
    }
    perMember.push({ m, outcomes });

    console.log(
      `  ${String(idx + 1).padStart(2)}  ${m.token.slice(0, 12)}  ${m.quoteSymbol.padEnd(8)}  ` +
        `+${String(Math.round(Number(m.launchBlock - first) * blockSecs)).padStart(5)}s  ` +
        `${peakPctToGrad.toFixed(1).padStart(9)}%  ${(peakPrice && entryPrice ? (peakPrice / entryPrice).toFixed(2) : "-").padStart(6)}x  ` +
        `${graduated ? "YES" : "no"}`,
    );
  }

  // ── the basket ────────────────────────────────────────────────────────────
  console.log(`\nBUYING ALL ${matches.length} — what each exit rule returns on the whole basket`);
  const names = ["hold to end", "trail 25%", "take profit 2x", "free ride @2x"];
  const traded = perMember.filter((p) => p.outcomes[0].name !== "never entered");
  console.log(`  ${traded.length} of ${matches.length} were tradeable\n`);
  // Positions are denominated in whatever their curve is quoted in — ETH on
  // some, SPCX or a stablecoin on others — so summing them as ETH would be
  // adding up different currencies. Equal-weighted percentages are the honest
  // aggregate: the return on staking the same proportional amount in each.
  console.log(`  rule                  n     mean    median      best     worst`);
  for (const n of names) {
    const vals = traded.map((p) => p.outcomes.find((o) => o.name === n)!.pnlPct);
    if (!vals.length) continue;
    const sorted = [...vals].sort((a, b) => a - b);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    console.log(
      `  ${n.padEnd(18)}${String(vals.length).padStart(5)}` +
        `${(mean.toFixed(1) + "%").padStart(9)}` +
        `${(sorted[Math.floor(sorted.length / 2)].toFixed(1) + "%").padStart(10)}` +
        `${(sorted[sorted.length - 1].toFixed(1) + "%").padStart(10)}` +
        `${(sorted[0].toFixed(1) + "%").padStart(10)}`,
    );
  }
  console.log(`\n${requests} RPC requests\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
