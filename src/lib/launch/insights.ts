import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

/**
 * What our own launch history says about a token idea before it exists.
 *
 * This is the part of the composer nobody else has. Every launchpad UI will
 * take a name and a ticker; none of them can tell you that this exact ticker
 * went out four times today and all four died, or that the tax you picked sits
 * in the worst-performing band we measured.
 *
 * All figures come from the scans in data/, measured across 114,544 launches:
 *
 *   quote token     stock/stablecoin 2.57% vs native ETH 1.51%
 *   creator tax     201-300bps 3.76%, 0bps 1.97%, 501+bps 0.29%
 *   ticker length   4-5 chars 1.79%, 9-12 0.87%, 13+ 0.47%
 *   ticker style    ALL CAPS 1.68%, mixed case 1.15%, with digits 1.05%
 *   FIRST 20s       8+ outside buyers 5.65% vs 0 buyers 0.11%
 *
 * That last one dwarfs the rest by 51x, and no naming choice can buy it — it
 * is distribution. The advice here is worth a little; having an audience at
 * second zero is worth everything.
 */

const SCAN_CANDIDATES = [
  "./data/scan.sqlite",
  "./data/scan-rep.sqlite",
  "./data/scan-bundle.sqlite",
  "./data/scan-dip.sqlite",
];
const SYMBOLS = "./data/symbols.sqlite";

/** Overall graduation rate in the scanned window, for context on every number. */
export const BASELINE_GRADUATION_PCT = 2.08;

export interface TickerHistory {
  /** Normalised ticker that was looked up. */
  ticker: string;
  /** Launches ever seen with this ticker. */
  launches: number;
  graduated: number;
  /** Launches in the most recent 24h of scanned data. */
  recent24h: number;
  /** Whether any launch with this ticker ever graduated. */
  everGraduated: boolean;
  /** Null when we have no symbol data at all. */
  known: boolean;
}

export interface LaunchAdvice {
  field: "symbol" | "name" | "tax" | "quote" | "description";
  level: "good" | "warn" | "bad";
  message: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

interface Store {
  scan: DatabaseSync | null;
  symbols: DatabaseSync | null;
  /** normalised ticker -> [launches, graduated, latestBlock] */
  byTicker: Map<string, [number, number, number]> | null;
  maxBlock: number;
}

// globalThis-backed: instrumentation and route handlers are separate module
// registries, and this opens large read-only files.
const KEY = "__ponsLaunchInsights__";
type G = typeof globalThis & { [KEY]?: Store };

function store(): Store {
  const g = globalThis as G;
  if (g[KEY]) return g[KEY]!;
  const s: Store = { scan: null, symbols: null, byTicker: null, maxBlock: 0 };

  const scanPath = SCAN_CANDIDATES.find((p) => existsSync(p));
  try {
    if (scanPath) s.scan = new DatabaseSync(scanPath, { readOnly: true });
    if (existsSync(SYMBOLS)) s.symbols = new DatabaseSync(SYMBOLS, { readOnly: true });
  } catch {
    // A scan mid-write, or a half-copied file. The composer still works, it
    // just cannot offer history — which must never block a launch.
    s.scan = null;
    s.symbols = null;
  }

  if (s.scan && s.symbols) {
    try {
      const grad = new Map<string, [number, number]>();
      for (const r of s.scan
        .prepare("SELECT token, graduated, launch_block FROM launches")
        .all() as unknown as { token: string; graduated: number; launch_block: number }[]) {
        grad.set(r.token, [r.graduated ? 1 : 0, r.launch_block]);
        if (r.launch_block > s.maxBlock) s.maxBlock = r.launch_block;
      }
      const by = new Map<string, [number, number, number]>();
      for (const r of s.symbols
        .prepare("SELECT token, symbol FROM symbols")
        .all() as unknown as { token: string; symbol: string }[]) {
        const k = norm(r.symbol);
        if (!k) continue;
        const g2 = grad.get(r.token);
        if (!g2) continue;
        const cur = by.get(k) ?? [0, 0, 0];
        cur[0] += 1;
        cur[1] += g2[0];
        if (g2[1] > cur[2]) cur[2] = g2[1];
        by.set(k, cur);
      }
      s.byTicker = by;
    } catch {
      s.byTicker = null;
    }
  }
  g[KEY] = s;
  return s;
}

export function insightsAvailable(): boolean {
  return store().byTicker !== null;
}

/** ~24h of Robinhood Chain blocks at ~0.101s. */
const DAY_BLOCKS = Math.round(86_400 / 0.101);

export function tickerHistory(ticker: string): TickerHistory {
  const s = store();
  const k = norm(ticker);
  if (!s.byTicker || !k) {
    return { ticker: k, launches: 0, graduated: 0, recent24h: 0, everGraduated: false, known: false };
  }
  const hit = s.byTicker.get(k);
  if (!hit) {
    return { ticker: k, launches: 0, graduated: 0, recent24h: 0, everGraduated: false, known: true };
  }
  const [launches, graduated, latest] = hit;
  return {
    ticker: k,
    launches,
    graduated,
    // Approximate: the ticker was used within a day of the scan's last block.
    recent24h: latest >= s.maxBlock - DAY_BLOCKS ? 1 : 0,
    everGraduated: graduated > 0,
    known: true,
  };
}

/**
 * Defaults drawn from the measured best-performing bands rather than taste.
 * A creator tax of 250bps sits in the 201-300 band, which graduated at 3.76%
 * against a 2.08% baseline — the single best tax choice in the data.
 */
export const LAUNCH_DEFAULTS = {
  creatorTaxBps: 250,
  preferStockQuote: true,
  maxSymbolChars: 5,
  maxNameChars: 32,
} as const;

/** Check a draft against what the data says, field by field. */
export function adviseLaunch(input: {
  symbol: string;
  name: string;
  creatorTaxBps: number;
  quoteIsNative: boolean;
  description: string;
}): LaunchAdvice[] {
  const out: LaunchAdvice[] = [];
  const sym = input.symbol.trim();

  // ── ticker ────────────────────────────────────────────────────────────────
  if (sym.length === 0) {
    out.push({ field: "symbol", level: "bad", message: "Ticker is required." });
  } else if (sym.length > 10) {
    out.push({ field: "symbol", level: "bad", message: "pons caps tickers at 10 characters." });
  } else if (sym.length > 8) {
    out.push({ field: "symbol", level: "bad", message: `${sym.length} chars — 13+ graduate at 0.47%. Shorten it.` });
  } else if (sym.length > 5) {
    out.push({ field: "symbol", level: "warn", message: `${sym.length} chars. 4-5 does best (1.79% vs 0.87% at 9-12).` });
  } else {
    out.push({ field: "symbol", level: "good", message: `${sym.length} chars — the best-performing length.` });
  }
  if (/[0-9]/.test(sym)) {
    out.push({ field: "symbol", level: "warn", message: "Digits in a ticker graduate at 1.05% vs 1.63% for letters only." });
  }
  if (sym && sym !== sym.toUpperCase()) {
    out.push({ field: "symbol", level: "warn", message: "ALL CAPS graduates at 1.68% vs 1.15% for mixed case." });
  }

  // ── name ──────────────────────────────────────────────────────────────────
  if (input.name.length > LAUNCH_DEFAULTS.maxNameChars) {
    out.push({ field: "name", level: "bad", message: `Name is ${input.name.length} chars; pons caps it at 32.` });
  }
  if (!input.name.trim()) {
    out.push({ field: "name", level: "bad", message: "Name is required." });
  }

  // ── creator tax ───────────────────────────────────────────────────────────
  const t = input.creatorTaxBps;
  if (t > 500) {
    out.push({ field: "tax", level: "bad", message: `${(t / 100).toFixed(1)}% tax — the 501+ band graduates at 0.29%, seven times worse than baseline.` });
  } else if (t >= 201 && t <= 300) {
    out.push({ field: "tax", level: "good", message: `${(t / 100).toFixed(1)}% is in the best band (3.76% graduation).` });
  } else if (t === 0) {
    out.push({ field: "tax", level: "warn", message: "No tax graduates at 1.97%, below the 3.76% of the 2-3% band." });
  } else {
    out.push({ field: "tax", level: "warn", message: `${(t / 100).toFixed(1)}% — 2-3% measured best at 3.76%.` });
  }

  // ── quote ─────────────────────────────────────────────────────────────────
  out.push(
    input.quoteIsNative
      ? { field: "quote", level: "warn", message: "ETH-quoted graduates at 1.51%; a stock or stablecoin pair does 2.57%." }
      : { field: "quote", level: "good", message: "Stock/stablecoin pair — 2.57% vs 1.51% for ETH." },
  );

  if (!input.description.trim()) {
    out.push({ field: "description", level: "warn", message: "Empty description. Costs nothing to fill in." });
  }
  return out;
}

/** Test seam. */
export function resetInsights(): void {
  const g = globalThis as G;
  try {
    g[KEY]?.scan?.close();
    g[KEY]?.symbols?.close();
  } catch {
    /* already closed */
  }
  delete g[KEY];
}
