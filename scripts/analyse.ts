/**
 * Analyses over data/scan.sqlite (produced by `npm run scan`).
 *
 *   npm run analyse            # all sections
 *   npm run analyse -- dip     # just one: dip | devs | buyers | presets
 *
 * NO-LOOKAHEAD RULE
 * -----------------
 * Reputation scores (deployers, early-buyer wallets) are built by walking
 * launches in block order and scoring each launch using ONLY launches that came
 * before it. Ranking wallets over the whole period and then "discovering" that
 * they predict winners is circular — they rank highly BECAUSE they bought the
 * winners. Every predictive claim here is out-of-sample by construction.
 */
import { DatabaseSync } from "node:sqlite";

const DB = "./data/scan.sqlite";
const only = process.argv[2];
const db = new DatabaseSync(DB);

const log = (m = "") => process.stdout.write(`${m}\n`);
const hr = (t: string) => {
  log(`\n${"═".repeat(78)}`);
  log(t);
  log("═".repeat(78));
};
const pct = (n: number, d: number) => (d === 0 ? "  –  " : `${((n / d) * 100).toFixed(2)}%`);
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface LaunchRow {
  token: string;
  deployer: string;
  launch_block: number;
  native: number;
  trades: number;
  buys: number;
  unique_buyers: number;
  peak_liq_eth: number;
  final_liq_eth: number;
  best_dip_depth: number;
  best_rip_from_dip: number;
  best_dip_liq_eth: number;
  graduated: number;
  entered: number;
  entry_liq_eth: number;
  entry_other_buys: number;
  entry_velocity: number;
}

function overview(): LaunchRow[] {
  const rows = db
    .prepare(`SELECT * FROM launches ORDER BY launch_block ASC`)
    .all() as unknown as LaunchRow[];
  const native = rows.filter((r) => r.native === 1);
  const grad = rows.filter((r) => r.graduated === 1);
  hr("DATASET");
  log(`  launches        ${rows.length}`);
  log(`  native-ETH      ${native.length}  (${pct(native.length, rows.length)})`);
  log(`  graduated       ${grad.length}  (${pct(grad.length, rows.length)} of all, ${pct(grad.filter(r=>r.native===1).length, native.length)} of native)`);
  log(`  never traded    ${rows.filter((r) => r.trades === 0).length}`);
  log(`  median trades   ${median(rows.map((r) => r.trades))}`);
  log(`  median peak liq ${median(native.map((r) => r.peak_liq_eth)).toFixed(4)} ETH`);
  return rows;
}

// ── 1. dip-then-rip ──────────────────────────────────────────────────────────
function dipAnalysis(rows: LaunchRow[]) {
  hr("DIP-THEN-RIP  (pump → dump → blast off)");
  const native = rows.filter((r) => r.native === 1 && r.trades >= 3);
  const dipped = native.filter((r) => r.best_dip_depth > 0);

  log(`\n  ${native.length} native tokens with ≥3 trades; ${dipped.length} dipped ≥25% at least once (${pct(dipped.length, native.length)})\n`);

  log(`  Given a dip of at least X, how often did the BEST subsequent recovery reach…`);
  log(`  ${"dip ≥".padEnd(8)}${"n".padStart(7)}${"+50%".padStart(9)}${"+100%".padStart(9)}${"+200%".padStart(9)}${"+500%".padStart(9)}${"median rip".padStart(12)}`);
  for (const d of [25, 40, 50, 65, 80, 90]) {
    const sel = dipped.filter((r) => r.best_dip_depth >= d);
    if (!sel.length) continue;
    const rips = sel.map((r) => r.best_rip_from_dip);
    log(
      `  ${(d + "%").padEnd(8)}${String(sel.length).padStart(7)}` +
        `${pct(rips.filter((x) => x >= 50).length, rips.length).padStart(9)}` +
        `${pct(rips.filter((x) => x >= 100).length, rips.length).padStart(9)}` +
        `${pct(rips.filter((x) => x >= 200).length, rips.length).padStart(9)}` +
        `${pct(rips.filter((x) => x >= 500).length, rips.length).padStart(9)}` +
        `${(median(rips).toFixed(0) + "%").padStart(12)}`,
    );
  }

  log(`\n  Same, split by how much liquidity sat in the curve AT THE DIP`);
  log(`  (your "buy it around 5K" idea — liquidity is the honest version of market cap)`);
  log(`  ${"liq at dip".padEnd(16)}${"n".padStart(7)}${"+100%".padStart(9)}${"+200%".padStart(9)}${"median rip".padStart(12)}`);
  const bands: [string, number, number][] = [
    ["< 0.1 ETH", 0, 0.1],
    ["0.1 – 0.5", 0.1, 0.5],
    ["0.5 – 1.0", 0.5, 1.0],
    ["1.0 – 2.0", 1.0, 2.0],
    ["2.0 – 4.2", 2.0, 4.2],
  ];
  for (const [label, lo, hi] of bands) {
    const sel = dipped.filter(
      (r) => r.best_dip_depth >= 40 && r.best_dip_liq_eth >= lo && r.best_dip_liq_eth < hi,
    );
    if (sel.length < 5) continue;
    const rips = sel.map((r) => r.best_rip_from_dip);
    log(
      `  ${label.padEnd(16)}${String(sel.length).padStart(7)}` +
        `${pct(rips.filter((x) => x >= 100).length, rips.length).padStart(9)}` +
        `${pct(rips.filter((x) => x >= 200).length, rips.length).padStart(9)}` +
        `${(median(rips).toFixed(0) + "%").padStart(12)}`,
    );
  }

  log(`\n  ⚠ These are HINDSIGHT-SELECTED: best_rip is the largest recovery over the`);
  log(`    token's life, so this is the CEILING of what dip-buying could capture, not`);
  log(`    what a live rule would get (it can't know which dip is "the" dip). Read it`);
  log(`    as: if the ceiling isn't clearly profitable, the real strategy can't be.`);
}

// ── 2. deployer reputation, no lookahead ─────────────────────────────────────
function devAnalysis(rows: LaunchRow[]) {
  hr("DEPLOYER TRACK RECORD  (scored only on their EARLIER launches)");
  const prior = new Map<string, { n: number; grad: number; peakSum: number }>();
  const buckets = new Map<string, { n: number; grad: number; peaks: number[] }>();
  const add = (k: string, r: LaunchRow) => {
    const b = buckets.get(k) ?? { n: 0, grad: 0, peaks: [] };
    b.n++;
    if (r.graduated) b.grad++;
    b.peaks.push(r.peak_liq_eth);
    buckets.set(k, b);
  };

  for (const r of rows) {
    if (r.native !== 1) continue;
    const p = prior.get(r.deployer);
    // classify using ONLY what was knowable before this launch
    if (!p) add("first-ever launch", r);
    else if (p.grad > 0) add(`has a prior graduate`, r);
    else if (p.n >= 20) add("20+ prior, none graduated", r);
    else if (p.n >= 5) add("5-19 prior, none graduated", r);
    else add("1-4 prior, none graduated", r);

    const cur = prior.get(r.deployer) ?? { n: 0, grad: 0, peakSum: 0 };
    cur.n++;
    if (r.graduated) cur.grad++;
    cur.peakSum += r.peak_liq_eth;
    prior.set(r.deployer, cur);
  }

  log(`\n  ${"deployer history at launch time".padEnd(30)}${"n".padStart(8)}${"graduated".padStart(11)}${"median peak liq".padStart(18)}`);
  const order = [
    "first-ever launch",
    "1-4 prior, none graduated",
    "5-19 prior, none graduated",
    "20+ prior, none graduated",
    "has a prior graduate",
  ];
  for (const k of order) {
    const b = buckets.get(k);
    if (!b) continue;
    log(
      `  ${k.padEnd(30)}${String(b.n).padStart(8)}${pct(b.grad, b.n).padStart(11)}` +
        `${(median(b.peaks).toFixed(4) + " ETH").padStart(18)}`,
    );
  }
  const base = [...buckets.values()].reduce((s, b) => s + b.grad, 0);
  const baseN = [...buckets.values()].reduce((s, b) => s + b.n, 0);
  log(`\n  baseline graduation rate: ${pct(base, baseN)}`);
  log(`  A bucket well above baseline is a usable filter; near it, the signal is noise.`);

  // spam detection
  const counts = [...prior.values()];
  log(`\n  ${counts.length} distinct deployers, ${counts.filter((c) => c.n >= 10).length} launched 10+, ` +
      `${counts.filter((c) => c.n >= 100).length} launched 100+`);
}

// ── 3. repeat early buyers, no lookahead ─────────────────────────────────────
function buyerAnalysis(rows: LaunchRow[]) {
  hr("EARLY BUYERS  (wallets scored only on tokens they bought EARLIER)");
  const early = db
    .prepare(`SELECT token, wallet FROM early_buyers ORDER BY rowid`)
    .all() as unknown as { token: string; wallet: string }[];
  const byToken = new Map<string, string[]>();
  for (const e of early) {
    const a = byToken.get(e.token);
    if (a) a.push(e.wallet);
    else byToken.set(e.token, [e.wallet]);
  }

  const score = new Map<string, { seen: number; good: number }>();
  const buckets = new Map<string, { n: number; grad: number }>();
  const add = (k: string, r: LaunchRow) => {
    const b = buckets.get(k) ?? { n: 0, grad: 0 };
    b.n++;
    if (r.graduated) b.grad++;
    buckets.set(k, b);
  };

  for (const r of rows) {
    if (r.native !== 1) continue;
    const wallets = byToken.get(r.token) ?? [];
    // How many of this token's early buyers had ALREADY been early on a winner?
    let proven = 0;
    for (const w of wallets) {
      const s = score.get(w);
      if (s && s.good > 0) proven++;
    }
    add(proven === 0 ? "0 proven early buyers" : proven === 1 ? "1 proven" : proven <= 3 ? "2-3 proven" : "4+ proven", r);

    for (const w of wallets) {
      const s = score.get(w) ?? { seen: 0, good: 0 };
      s.seen++;
      if (r.graduated) s.good++;
      score.set(w, s);
    }
  }

  log(`\n  ${score.size} distinct early-buyer wallets across ${byToken.size} tokens\n`);
  log(`  ${"proven winners among early buyers".padEnd(34)}${"n".padStart(8)}${"graduated".padStart(11)}`);
  for (const k of ["0 proven early buyers", "1 proven", "2-3 proven", "4+ proven"]) {
    const b = buckets.get(k);
    if (!b) continue;
    log(`  ${k.padEnd(34)}${String(b.n).padStart(8)}${pct(b.grad, b.n).padStart(11)}`);
  }

  const repeat = [...score.values()].filter((s) => s.good >= 2).length;
  log(`\n  ${repeat} wallets were early on 2+ tokens that graduated`);
  log(`  If "4+ proven" is far above baseline, a copy-signal filter is worth building.`);
}

// ── 4. preset outcomes over the full dataset ─────────────────────────────────
function presetAnalysis() {
  hr("EXIT PRESETS  (every entered position, unclosed marked to market)");
  const rows = db
    .prepare(
      `SELECT preset, COUNT(*) n,
              SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) wins,
              AVG(pnl_pct) avg,
              SUM(pnl_pct) total
       FROM sims GROUP BY preset ORDER BY avg DESC`,
    )
    .all() as unknown as { preset: string; n: number; wins: number; avg: number; total: number }[];
  log(`\n  ${"preset".padEnd(12)}${"n".padStart(8)}${"win".padStart(8)}${"avg".padStart(9)}${"net ETH @0.01".padStart(15)}`);
  for (const r of rows) {
    log(
      `  ${r.preset.padEnd(12)}${String(r.n).padStart(8)}${pct(r.wins, r.n).padStart(8)}` +
        `${((r.avg >= 0 ? "+" : "") + r.avg.toFixed(1) + "%").padStart(9)}` +
        `${((r.total / 100) * 0.01).toFixed(4).padStart(15)}`,
    );
  }
  const reasons = db
    .prepare(`SELECT preset, reason, COUNT(*) n FROM sims GROUP BY preset, reason`)
    .all() as unknown as { preset: string; reason: string; n: number }[];
  const byPreset = new Map<string, string[]>();
  for (const r of reasons) {
    const a = byPreset.get(r.preset) ?? [];
    a.push(`${r.reason} ${r.n}`);
    byPreset.set(r.preset, a);
  }
  log(`\n  exit reasons:`);
  for (const [p, a] of byPreset) log(`    ${p.padEnd(12)} ${a.join(", ")}`);
}

const rows = overview();
if (!only || only === "dip") dipAnalysis(rows);
if (!only || only === "devs") devAnalysis(rows);
if (!only || only === "buyers") buyerAnalysis(rows);
if (!only || only === "presets") presetAnalysis();
log();
