"use client";

/**
 * Filters for the launch feed.
 *
 * Deliberately only the fields this app actually measures. It would be easy to
 * put a "honeypot" or "LP burnt" box on the panel and quietly never tick it,
 * and a filter that cannot fail is worse than a missing one — it tells a
 * trader something has been checked when nothing has.
 *
 * Everything here is applied in the browser to rows already on screen, so
 * changing a filter is instant and costs no request. The feed holds the newest
 * 250 launches, which means a filter narrows what you can see rather than
 * searching further back.
 */

/** The subset of a feed row a filter can read. */
export interface Filterable {
  quoteSymbol: string;
  ageMinutes: number;
  trades: number;
  buys: number;
  sells: number;
  holders: number;
  progressPct: number;
  devHoldRate: number;
  devSold: boolean;
  devLaunches: number;
  top10Rate: number;
  mcapUsd: number | null;
  volumeUsd: number | null;
  liquidityUsd: number | null;
  socials: string;
  snipers: number;
  bundled: number;
}

/** A min/max pair. Empty strings mean "no bound", not zero. */
export interface Range {
  min: string;
  max: string;
}

export interface Filters {
  /** Hide launches with a detected operator bundle. */
  noBundled: boolean;
  /** Hide launches where the deployer has already sold. */
  noDevSold: boolean;
  /** Hide launches priced in anything but ETH. */
  ethOnly: boolean;
  /** Only launches that published a link. */
  hasSocials: boolean;
  /** Only launches that have traded at least once. */
  tradedOnly: boolean;
  ageMin: Range;
  mcapUsd: Range;
  volumeUsd: Range;
  liquidityUsd: Range;
  holders: Range;
  trades: Range;
  buys: Range;
  sells: Range;
  progressPct: Range;
  top10Pct: Range;
  devHoldPct: Range;
  devLaunches: Range;
  snipers: Range;
  bundled: Range;
}

const NONE: Range = { min: "", max: "" };

export const DEFAULT_FILTERS: Filters = {
  noBundled: false,
  noDevSold: false,
  ethOnly: false,
  hasSocials: false,
  tradedOnly: false,
  ageMin: { ...NONE },
  mcapUsd: { ...NONE },
  volumeUsd: { ...NONE },
  liquidityUsd: { ...NONE },
  holders: { ...NONE },
  trades: { ...NONE },
  buys: { ...NONE },
  sells: { ...NONE },
  progressPct: { ...NONE },
  top10Pct: { ...NONE },
  devHoldPct: { ...NONE },
  devLaunches: { ...NONE },
  snipers: { ...NONE },
  bundled: { ...NONE },
};

const STORE = "ponsnipe.feedfilters.v1";

export function readFilters(): Filters {
  try {
    const raw = localStorage.getItem(STORE);
    // Merged over the defaults so a set saved before a field existed does not
    // come back with that field undefined and crash the predicate.
    return raw ? { ...DEFAULT_FILTERS, ...(JSON.parse(raw) as Filters) } : DEFAULT_FILTERS;
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function writeFilters(f: Filters): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(f));
  } catch {
    /* private mode: filters hold for this session and no longer */
  }
}

/** How many filters are doing something. Drives the badge on the button. */
export function activeCount(f: Filters): number {
  let n = 0;
  for (const [k, v] of Object.entries(f)) {
    if (typeof v === "boolean") {
      if (v) n++;
    } else if (v && typeof v === "object") {
      const r = v as Range;
      if (r.min.trim() !== "" || r.max.trim() !== "") n++;
    }
    void k;
  }
  return n;
}

/**
 * Is this value inside the range?
 *
 * A blank bound is no bound. A null value fails any range that has one, which
 * is the honest reading: a coin with no recorded liquidity does not satisfy
 * "liquidity over 1k", and treating the gap as zero would silently include
 * launches nobody has measured yet.
 */
function within(value: number | null, r: Range): boolean {
  const lo = r.min.trim() === "" ? null : Number(r.min);
  const hi = r.max.trim() === "" ? null : Number(r.max);
  if (lo === null && hi === null) return true;
  if (value == null || Number.isNaN(value)) return false;
  if (lo !== null && !Number.isNaN(lo) && value < lo) return false;
  if (hi !== null && !Number.isNaN(hi) && value > hi) return false;
  return true;
}

/** Thousands, because the money fields are typed in K to keep them short. */
const K = 1000;

export function passes(row: Filterable, f: Filters): boolean {
  if (f.noBundled && (row.bundled ?? 0) >= 2) return false;
  if (f.noDevSold && row.devSold) return false;
  if (f.ethOnly && (row.quoteSymbol ?? "").toUpperCase() !== "ETH") return false;
  if (f.hasSocials && !(row.socials ?? "").trim()) return false;
  if (f.tradedOnly && !(row.trades > 0)) return false;

  if (!within(row.ageMinutes, f.ageMin)) return false;
  if (!within(row.holders, f.holders)) return false;
  if (!within(row.trades, f.trades)) return false;
  if (!within(row.buys, f.buys)) return false;
  if (!within(row.sells, f.sells)) return false;
  if (!within(row.snipers, f.snipers)) return false;
  if (!within(row.bundled, f.bundled)) return false;
  if (!within(row.devLaunches, f.devLaunches)) return false;
  if (!within(row.progressPct, f.progressPct)) return false;

  // Rates arrive as 0-1 and are typed as percentages.
  if (!within((row.top10Rate ?? 0) * 100, f.top10Pct)) return false;
  if (!within((row.devHoldRate ?? 0) * 100, f.devHoldPct)) return false;

  // Money is typed in thousands: "5" means $5k.
  if (!within(row.mcapUsd == null ? null : row.mcapUsd / K, f.mcapUsd)) return false;
  if (!within(row.volumeUsd == null ? null : row.volumeUsd / K, f.volumeUsd)) return false;
  if (!within(row.liquidityUsd == null ? null : row.liquidityUsd / K, f.liquidityUsd)) return false;

  return true;
}
