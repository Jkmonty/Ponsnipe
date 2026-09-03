import type { PositionRow, CloseReason } from "../db/positions";
import { unrealisedPnlPct } from "../db/positions";

export interface ExitDecision {
  shouldExit: boolean;
  reason: CloseReason | null;
  pnlPct: number;
  /** New peak price to persist (for trailing stops). */
  peakPrice: number;
  detail: string;
}

export interface ExitInputs {
  /** Current token price in the quote asset. */
  price: number;
  /**
   * How far the curve is toward graduation, 0-100. Undefined when unknown
   * (e.g. the launch record had no threshold), which disables the rule.
   */
  graduationPct?: number;
}

/**
 * Pure function: given a position and the latest market state, decide whether
 * to sell. Take-profit and stop-loss are absolute vs. entry, trailing stop is
 * vs. peak, and the graduation exit is vs. curve progress.
 *
 * Order matters. Stop-loss is checked first (capital preservation), then the
 * graduation exit — because past graduation the bonding curve stops accepting
 * sells altogether, so a position that would have hit take-profit later is
 * better closed now than stranded. Take-profit and trailing follow.
 */
export function evaluateExit(
  row: PositionRow,
  input: ExitInputs | number,
): ExitDecision {
  const { price, graduationPct } =
    typeof input === "number" ? { price: input, graduationPct: undefined } : input;

  const pnlPct = unrealisedPnlPct(row, price);
  const peakPrice = Math.max(row.peak_price, price);

  if (row.stop_loss_pct != null && pnlPct <= -Math.abs(row.stop_loss_pct)) {
    return {
      shouldExit: true,
      reason: "stop_loss",
      pnlPct,
      peakPrice,
      detail: `PnL ${pnlPct.toFixed(2)}% <= -${Math.abs(row.stop_loss_pct)}%`,
    };
  }

  // Get out while the curve can still sell. After graduation the token only
  // trades in a Uniswap v4 pool, which this engine cannot exit yet — so a
  // winner that runs to the threshold would otherwise become a stranded bag.
  if (
    row.graduation_exit_pct != null &&
    graduationPct != null &&
    Number.isFinite(graduationPct) &&
    graduationPct >= row.graduation_exit_pct
  ) {
    return {
      shouldExit: true,
      reason: "graduation_exit",
      pnlPct,
      peakPrice,
      detail: `curve ${graduationPct.toFixed(1)}% >= ${row.graduation_exit_pct}% to graduation (PnL ${pnlPct.toFixed(2)}%)`,
    };
  }

  if (row.take_profit_pct != null && pnlPct >= row.take_profit_pct) {
    return {
      shouldExit: true,
      reason: "take_profit",
      pnlPct,
      peakPrice,
      detail: `PnL ${pnlPct.toFixed(2)}% >= +${row.take_profit_pct}%`,
    };
  }

  if (row.trailing_stop_pct != null && row.peak_price > 0) {
    const dropFromPeakPct = ((price - peakPrice) / peakPrice) * 100;
    if (dropFromPeakPct <= -Math.abs(row.trailing_stop_pct)) {
      return {
        shouldExit: true,
        reason: "trailing_stop",
        pnlPct,
        peakPrice,
        detail: `${dropFromPeakPct.toFixed(2)}% from peak <= -${Math.abs(
          row.trailing_stop_pct,
        )}%`,
      };
    }
  }

  return {
    shouldExit: false,
    reason: null,
    pnlPct,
    peakPrice,
    detail: `PnL ${pnlPct.toFixed(2)}%`,
  };
}

/** Curve progress toward graduation as a percentage, or undefined if unknown. */
export function graduationProgressPct(
  realQuoteReserve: bigint,
  thresholdWei: string | null,
): number | undefined {
  if (!thresholdWei) return undefined;
  let threshold: bigint;
  try {
    threshold = BigInt(thresholdWei);
  } catch {
    return undefined;
  }
  if (threshold <= 0n) return undefined;
  return Math.min(100, (Number(realQuoteReserve) / Number(threshold)) * 100);
}
