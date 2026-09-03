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

/**
 * Pure function: given a position and the latest price, decide whether to sell.
 * Take-profit and stop-loss are absolute vs. entry. Trailing stop is vs. peak.
 */
export function evaluateExit(row: PositionRow, currentPrice: number): ExitDecision {
  const pnlPct = unrealisedPnlPct(row, currentPrice);
  const peakPrice = Math.max(row.peak_price, currentPrice);

  if (row.stop_loss_pct != null && pnlPct <= -Math.abs(row.stop_loss_pct)) {
    return {
      shouldExit: true,
      reason: "stop_loss",
      pnlPct,
      peakPrice,
      detail: `PnL ${pnlPct.toFixed(2)}% <= -${Math.abs(row.stop_loss_pct)}%`,
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
    const dropFromPeakPct = ((currentPrice - peakPrice) / peakPrice) * 100;
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
