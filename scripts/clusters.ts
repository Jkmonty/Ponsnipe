/**
 * Narrative clusters: when a story breaks, the same coin gets minted over and
 * over, a few migrate, and one becomes the runner.
 *
 *   npm run clusters                  # fetch symbols (resumable), then analyse
 *   npm run clusters -- --window 6    # cluster tokens launching within 6h
 *
 * Why this is worth testing when five other strategies are dead: every one of
 * those failed the same way, with a single winner unable to carry hundreds of
 * losers. A cluster is a basket of a handful. If one member runs +500% while
 * three go to -80%, the basket is up ~65%. Shrinking the denominator from a
 * thousand to four changes the arithmetic completely, and nothing tested so far
 * has conditioned on a token having lookalikes at all.
 *
 * Clusters are keyed on the normalised SYMBOL, since copies of a narrative
 * share a ticker, and split into waves so the same ticker reused a week later
 * is not treated as the same event.
 *
 * EVERY quote type is included. Symbols were originally fetched for ETH-quoted
 * launches only, which made the whole narrative-wave finding half-blind: a real
 * wave like $CONCERN was two-thirds USDG/AMZN/NVDA and we were looking at the
 * ETH third of it.
 *
 * Symbols are cached in data/symbols.sqlite so re-analysis costs no RPC.
 *
 * Reads only. Nothing is signed.
 */
try {
  process.loadEnvFile?.(".env");
} catch {
  /* ignore */
}

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { createPublicClient, http, type Address } from "viem";
import { robinhoodChain } from "../src/lib/chain";
import { erc20Abi } from "../src/lib/pons/abis";

const RPC = process.env.BACKTEST_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const SCAN = "./data/scan.sqlite";
const SYMS = "./data/symbols.sqlite";

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1]);
    if (Number.isFinite(n)) return n;
  }
  return dflt;
}
const WINDOW_HOURS = arg("window", 6);
const RPS = arg("rps", 3);
const BATCH = 150;
const BLOCK_SECS = 0.101;

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(RPC, { retryCount: 2, timeout: 30_000 }),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MIN_INTERVAL = 1000 / Math.max(0.5, RPS);
let lastCall = 0;
async function rpc<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const wait = MIN_INTERVAL - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    try {
      return await fn();
    } catch (e) {
      const s = String(e);
      const retry = s.includes("429") || s.includes("403") || /too many requests|cf-mitigated|timeout|timed out/i.test(s);
      if (!retry || attempt >= 8) throw e;
      await sleep(Math.min(60_000, 2_000 * 2 ** attempt));
    }
  }
}

try {
  mkdirSync("./data", { recursive: true });
} catch {
  /* exists */
}

const scan = new DatabaseSync(SCAN, { readOnly: true });
const sym = new DatabaseSync(SYMS);
sym.exec("PRAGMA journal_mode = WAL;");
sym.exec(`CREATE TABLE IF NOT EXISTS symbols (token TEXT PRIMARY KEY, symbol TEXT)`);

interface Row {
  token: string;
  launch_block: number;
  graduated: number;
  unique_buyers: number;
  peak_liq_eth: number;
  entered: number;
}

async function fetchSymbols(): Promise<void> {
  const have = new Set(
    (sym.prepare("SELECT token FROM symbols").all() as unknown as { token: string }[]).map((r) => r.token),
  );
  const all = scan
    .prepare("SELECT token FROM launches")
    .all() as unknown as { token: string }[];
  const todo = all.map((r) => r.token).filter((t) => !have.has(t));
  if (!todo.length) {
    console.log(`  symbols: all ${all.length} already cached\n`);
    return;
  }
  console.log(`  symbols: ${have.size} cached, fetching ${todo.length} more (~${Math.ceil(todo.length / BATCH / RPS / 60)} min)`);
  const ins = sym.prepare("INSERT OR REPLACE INTO symbols VALUES (?,?)");
  for (let i = 0; i < todo.length; i += BATCH) {
    const slice = todo.slice(i, i + BATCH);
    const res = await rpc(() =>
      client.multicall({
        contracts: slice.map((t) => ({
          address: t as Address,
          abi: erc20Abi,
          functionName: "symbol" as const,
        })),
        allowFailure: true,
      }),
    );
    sym.exec("BEGIN");
    for (let k = 0; k < slice.length; k++) {
      const r = res[k];
      // A token whose symbol() reverts still gets a row, so a rerun does not
      // keep retrying it forever.
      ins.run(slice[k], r.status === "success" ? String(r.result) : "");
    }
    sym.exec("COMMIT");
    process.stdout.write(`\r    ${Math.min(i + BATCH, todo.length)}/${todo.length}   `);
  }
  console.log("");
}

/** Copies of a narrative share a ticker; case and punctuation vary. */
function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function analyse(): void {
  const rows = scan
    .prepare(
      "SELECT token, launch_block, graduated, unique_buyers, peak_liq_eth, entered FROM launches",
    )
    .all() as unknown as Row[];
  const symbols = new Map(
    (sym.prepare("SELECT token, symbol FROM symbols").all() as unknown as { token: string; symbol: string }[]).map(
      (r) => [r.token, r.symbol],
    ),
  );

  // pnl per token per preset
  const pnl = new Map<string, Map<string, number>>();
  for (const r of scan.prepare("SELECT token, preset, pnl_pct FROM sims").all() as unknown as {
    token: string;
    preset: string;
    pnl_pct: number;
  }[]) {
    let m = pnl.get(r.preset);
    if (!m) pnl.set(r.preset, (m = new Map()));
    m.set(r.token, r.pnl_pct);
  }

  // ── build clusters ────────────────────────────────────────────────────────
  const bySymbol = new Map<string, Row[]>();
  let noSymbol = 0;
  for (const r of rows) {
    const s = normalise(symbols.get(r.token) ?? "");
    if (!s) {
      noSymbol++;
      continue;
    }
    let a = bySymbol.get(s);
    if (!a) bySymbol.set(s, (a = []));
    a.push(r);
  }

  const windowBlocks = (WINDOW_HOURS * 3600) / BLOCK_SECS;
  const clusters: Row[][] = [];
  for (const [, arr] of bySymbol) {
    arr.sort((a, b) => a.launch_block - b.launch_block);
    let cur: Row[] = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
      // A ticker reused days later is a different event, not the same wave.
      if (arr[i].launch_block - cur[cur.length - 1].launch_block <= windowBlocks) cur.push(arr[i]);
      else {
        clusters.push(cur);
        cur = [arr[i]];
      }
    }
    clusters.push(cur);
  }

  console.log(`\n${rows.length} native tokens, ${noSymbol} without a readable symbol`);
  console.log(`${bySymbol.size} distinct symbols, ${clusters.length} waves (same ticker within ${WINDOW_HOURS}h)\n`);

  const sizeBand = (n: number) => (n === 1 ? "1 (unique)" : n <= 2 ? "2" : n <= 4 ? "3-4" : n <= 9 ? "5-9" : n <= 24 ? "10-24" : "25+");
  const order = ["1 (unique)", "2", "3-4", "5-9", "10-24", "25+"];

  // ── does having lookalikes predict anything? ──────────────────────────────
  console.log("DOES A TOKEN HAVING LOOKALIKES PREDICT SUCCESS?");
  console.log("  cluster size   waves    tokens   graduated   % of clusters with >=1 graduate");
  const byBand = new Map<string, { waves: number; tokens: number; grads: number; withGrad: number }>();
  for (const c of clusters) {
    const b = sizeBand(c.length);
    const e = byBand.get(b) ?? { waves: 0, tokens: 0, grads: 0, withGrad: 0 };
    e.waves++;
    e.tokens += c.length;
    const g = c.reduce((s, r) => s + r.graduated, 0);
    e.grads += g;
    if (g > 0) e.withGrad++;
    byBand.set(b, e);
  }
  for (const b of order) {
    const e = byBand.get(b);
    if (!e) continue;
    console.log(
      `  ${b.padEnd(13)}${String(e.waves).padStart(6)}${String(e.tokens).padStart(10)}` +
        `${((e.grads / e.tokens) * 100).toFixed(2).padStart(11)}%${((e.withGrad / e.waves) * 100).toFixed(1).padStart(12)}%`,
    );
  }

  // ── the basket trade ──────────────────────────────────────────────────────
  console.log(`\nBASKET: buy EVERY member of a wave, one position each, same exit rule`);
  console.log(`  (mean is per token, so it is directly comparable to every earlier result)`);
  console.log(`  preset      size     baskets   tokens     mean    median      p90`);
  for (const preset of ["hold", "trail25", "moonshot", "wide"]) {
    const m = pnl.get(preset);
    if (!m) continue;
    for (const b of ["1 (unique)", "3-4", "5-9", "10-24", "25+"]) {
      const vals: number[] = [];
      let baskets = 0;
      for (const c of clusters) {
        if (sizeBand(c.length) !== b) continue;
        const got = c.map((r) => m.get(r.token)).filter((v): v is number => v != null);
        if (!got.length) continue;
        baskets++;
        vals.push(...got);
      }
      if (vals.length < 50) continue;
      const sorted = [...vals].sort((x, y) => x - y);
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      console.log(
        `  ${preset.padEnd(11)}${b.padEnd(9)}${String(baskets).padStart(8)}${String(vals.length).padStart(9)}` +
          `${(mean.toFixed(1) + "%").padStart(9)}${(sorted[Math.floor(sorted.length / 2)].toFixed(1) + "%").padStart(10)}` +
          `${(sorted[Math.floor(sorted.length * 0.9)].toFixed(1) + "%").padStart(9)}`,
      );
    }
    console.log("");
  }

  // ── which member becomes the runner? ──────────────────────────────────────
  console.log("WITHIN A WAVE THAT PRODUCED A GRADUATE, WHICH MEMBER WAS IT?");
  let firstWins = 0, buyerWins = 0, total = 0, multiGrad = 0;
  for (const c of clusters) {
    if (c.length < 2) continue;
    const grads = c.filter((r) => r.graduated);
    if (!grads.length) continue;
    total++;
    if (grads.length > 1) multiGrad++;
    const first = c.reduce((a, b) => (a.launch_block <= b.launch_block ? a : b));
    if (first.graduated) firstWins++;
    const mostBuyers = c.reduce((a, b) => (a.unique_buyers >= b.unique_buyers ? a : b));
    if (mostBuyers.graduated) buyerWins++;
  }
  if (total) {
    console.log(`  ${total} waves (size 2+) produced at least one graduate`);
    console.log(`  the FIRST launched was a graduate in      ${((firstWins / total) * 100).toFixed(1)}% of them`);
    console.log(`  the one with MOST early buyers was        ${((buyerWins / total) * 100).toFixed(1)}%`);
    console.log(`  more than one member graduated in         ${((multiGrad / total) * 100).toFixed(1)}%`);
  }
  console.log("");
}

async function main() {
  console.log(`\nnarrative clusters — same ticker within ${WINDOW_HOURS}h\n`);
  await fetchSymbols();
  analyse();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
