/** Formatting helpers safe for both server and client (no node imports). */

export function fmtEth(v: number | string, dp = 5): string {
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) return "–";
  if (n !== 0 && Math.abs(n) < 10 ** -dp) return n.toExponential(2);
  return n.toLocaleString(undefined, { maximumFractionDigits: dp });
}

export function fmtPrice(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "–";
  if (v < 1e-6) return v.toExponential(3);
  return v.toLocaleString(undefined, { maximumSignificantDigits: 6 });
}

export function fmtPct(v: number | null | undefined, dp = 2): string {
  if (v == null || !Number.isFinite(v)) return "–";
  return `${v >= 0 ? "+" : ""}${v.toFixed(dp)}%`;
}

export function fmtUsdish(v: number): string {
  if (!Number.isFinite(v)) return "–";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(2)}k`;
  return v.toFixed(2);
}

export function shortAddr(a: string): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
}

export function weiToUnits(wei: string | bigint, decimals: number): number {
  const s = typeof wei === "bigint" ? wei.toString() : wei;
  try {
    return Number(BigInt(s)) / 10 ** decimals;
  } catch {
    return 0;
  }
}

export const EXPLORER = "https://robinhoodchain.blockscout.com";
