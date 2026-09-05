/**
 * The narrative-wave trade, as a rule a bot could actually run.
 *
 *   npm run waves
 *   npm run waves -- --window 6
 *
 * The cluster analysis found the strongest signal in this project: tokens
 * sharing a ticker within a few hours produce a graduate 51% of the time at 25+
 * copies against 0.8% for a one-off, only 5.5% of waves have more than one
 * graduate, and picking the member with the most buyers in its first 20 seconds
 * lands on the graduate 67.3% of the time against a 30.2% baseline.
 *
 * None of that is yet a strategy. Those figures are measured on waves that
 * ENDED at a given size; live you see a wave part-grown and must decide now.
 * This script closes that gap.
 *
 * THE RULE, decided at one moment with nothing from the future:
 *   at T's launch + 20s (exactly where every sim in scan.sqlite enters),
 *     - count copies of T's ticker launched within the window BEFORE T
 *     - require the wave to already be at least `trigger` strong
 *     - require T to lead every member whose own 20s has elapsed on early buyers
 *   then buy T and take that token's real simulated outcome.
 *
 * Waves that never reach the trigger produce no trade, and waves that trigger
 * and fizzle are counted in full — that second part is what kills strategies
 * that look good in hindsight, and the reason this exists.
 *
 * A no-pick control buys EVERY member once the wave triggers. If picking does
 * not beat it, the buyer-count edge is imaginary and only wave size matters.
 *
 * Offline: reads data/scan.sqlite and data/symbols.sqlite. No RPC.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const SCAN = "./data/scan.sqlite";
const SYMS = "./data/symbols.sqlite";
const BLOCK_SECS = 0.101;
/** Every sim in scan.sqlite buys 20s after launch; the decision must match. */
const DELAY_BLOCKS = Math.round(20 / BLOCK_SECS);

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1]);
    if (Number.isFinite(n)) return n;
  }
  return dflt;
}
const WINDOW_HOURS = arg("window", 6);
const WINDOW_BLOCKS = (WINDOW_HOURS * 3600) / BLOCK_SECS;

if (!existsSync(SYMS)) {
  console.error("\nNo data/symbols.sqlite — run `npm run clusters` first.\n");
  process.exit(1);
}

const scan = new DatabaseSync(SCAN, { readOnly: true });
const symdb = new DatabaseSync(SYMS, { readOnly: true });

interface Tok {
  token: string;
  launch: number;
  /** Buys by wallets other than the deployer inside the 20s window. */
  earlyBuys: number;
  graduated: number;
}

const symbols = new Map(
  (symdb.prepare("SELECT token, symbol FROM symbols").all() as unknown as { token: string; symbol: string }[]).map(
    (r) => [r.token, r.symbol],
  ),
);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const toks = (
  scan
    .prepare(
      "SELECT token, launch_block, entry_other_buys, graduated FROM launches ORDER BY launch_block",
    )
    .all() as unknown as {
    token: string;
    launch_block: number;
    entry_other_buys: number;
    graduated: number;
  }[]
).map((r) => ({
  token: r.token,
  launch: r.launch_block,
  earlyBuys: r.entry_other_buys ?? 0,
  graduated: r.graduated,
}));

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

function pct(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.floor(q * (s.length - 1))))];
}
function bootstrapCI(xs: number[], iters = 2000): [number, number] {
  if (xs.length < 2) return [NaN, NaN];
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let k = 0; k < xs.length; k++) s += xs[(Math.random() * xs.length) | 0];
    means.push(s / xs.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * iters)], means[Math.floor(0.975 * iters)]];
}

interface Trade {
  token: string;
  graduated: number;
}

/**
 * Walk every launch in block order and apply the rule at each token's decision
 * moment. `pickBest` false is the control: take every member of a triggered
 * wave instead of only the leader.
 */
function run(trigger: number, pickBest: boolean, maxPerWave = Infinity): Trade[] {
  const waves = new Map<string, Tok[]>();
  const trades: Trade[] = [];
  // How many copies of each ticker this wave has already had us buy. Jake's
  // point: you cannot buy the first few copies, because until the wave reveals
  // itself there is nothing to tell them from any other launch. You can only
  // buy the next few AFTER it reveals itself, and then stop.
  const bought = new Map<string, number>();

  for (const t of toks) {
    const sym = norm(symbols.get(t.token) ?? "");
    if (!sym) continue;

    let members = waves.get(sym);
    if (!members) waves.set(sym, (members = []));
    // Only copies still inside the window count towards the wave.
    while (members.length && t.launch - members[0].launch > WINDOW_BLOCKS) members.shift();

    const priors = members.slice();
    // A wave that has aged out of the window starts its budget over.
    if (!priors.length) bought.set(sym, 0);
    members.push(t);

    // Wave strength AS OF NOW: this copy plus the ones already launched.
    if (priors.length + 1 < trigger) continue;

    if ((bought.get(sym) ?? 0) >= maxPerWave) continue;

    if (!pickBest) {
      trades.push({ token: t.token, graduated: t.graduated });
      bought.set(sym, (bought.get(sym) ?? 0) + 1);
      continue;
    }

    // Compare only against members whose own 20s has already elapsed — the
    // others have no observable buyer count yet at this instant.
    let leads = true;
    for (const p of priors) {
      if (p.launch + DELAY_BLOCKS > t.launch) continue;
      if (p.earlyBuys > t.earlyBuys) {
        leads = false;
        break;
      }
    }
    if (leads) {
      trades.push({ token: t.token, graduated: t.graduated });
      bought.set(sym, (bought.get(sym) ?? 0) + 1);
    }
  }
  return trades;
}

function report(label: string, trades: Trade[], preset: string): void {
  const m = pnl.get(preset);
  if (!m) return;
  const vals: number[] = [];
  let grads = 0;
  for (const t of trades) {
    const v = m.get(t.token);
    if (v == null) continue;
    vals.push(v);
    grads += t.graduated;
  }
  if (vals.length < 30) {
    console.log(`  ${label.padEnd(26)}${String(vals.length).padStart(7)}   (too few)`);
    return;
  }
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const sorted = [...vals].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * 0.05);
  const trimmed = sorted.slice(cut, sorted.length - cut);
  const tmean = trimmed.reduce((s, v) => s + v, 0) / Math.max(1, trimmed.length);
  const [lo, hi] = bootstrapCI(vals);
  const win = (vals.filter((v) => v > 0).length / vals.length) * 100;
  console.log(
    `  ${label.padEnd(26)}${String(vals.length).padStart(7)}` +
      `${((grads / vals.length) * 100).toFixed(2).padStart(8)}%` +
      `${(win.toFixed(0) + "%").padStart(7)}` +
      `${(mean.toFixed(1) + "%").padStart(9)}${(tmean.toFixed(1) + "%").padStart(9)}` +
      `${(pct(vals, 0.5).toFixed(1) + "%").padStart(9)}` +
      `   [${lo.toFixed(1)}%, ${hi.toFixed(1)}%]`,
  );
}

console.log(`\nnarrative-wave trade, decided at launch+20s with no lookahead`);
console.log(`window ${WINDOW_HOURS}h, ${toks.length} native tokens\n`);

const BASE = pnl.get("trail25");
if (BASE) {
  const all = [...BASE.values()];
  const gradAll = toks.filter((t) => t.graduated).length / toks.length;
  console.log(
    `baseline — every launch, trail25: n=${all.length}  graduated ${(gradAll * 100).toFixed(2)}%  ` +
      `mean ${(all.reduce((s, v) => s + v, 0) / all.length).toFixed(1)}%\n`,
  );
}

for (const preset of ["trail25", "moonshot", "balanced", "hold"]) {
  console.log(`${preset.toUpperCase()}`);
  console.log(`  rule                            n   graduated    win     mean    trim5   median   95% CI`);
  for (const trigger of [2, 3, 5, 8]) {
    report(`wave>=${trigger}, buy all`, run(trigger, false), preset);
    for (const cap of [3, 5]) {
      report(`wave>=${trigger}, next ${cap} only`, run(trigger, false, cap), preset);
    }
    report(`wave>=${trigger}, leader only`, run(trigger, true), preset);
  }
  console.log("");
}
