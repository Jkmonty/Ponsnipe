import { getAddress } from "viem";
import { logEngine } from "../db/index";
import { isLive } from "./liveState";
import {
  claimForClosing,
  getPosition,
  updatePosition,
  type CloseReason,
} from "../db/positions";
import { sellOnCurve } from "../pons/swap";
import { getCurveState } from "../pons/tokens";

/**
 * Execute the sell for a position and record the outcome.
 * Safe to call from the monitor or from a manual "close now" request:
 * `claimForClosing` guarantees only one caller actually sells.
 */
export async function closePosition(
  id: string,
  reason: CloseReason,
  opts: { alreadyClaimed?: boolean } = {},
): Promise<{ ok: boolean; message: string }> {
  const row = getPosition(id);
  if (!row) return { ok: false, message: "position not found" };
  if (row.status === "closed") return { ok: false, message: "already closed" };

  if (!opts.alreadyClaimed && !claimForClosing(id)) {
    return { ok: false, message: `position is ${getPosition(id)?.status}` };
  }

  if (!isLive()) {
    logEngine("warn", `DRY RUN — would sell ${row.token_symbol} (${reason})`, id);
    updatePosition(id, { status: "open", last_checked_at: new Date().toISOString() });
    return { ok: false, message: "dry-run: ENGINE_LIVE is not set" };
  }

  const tokensHeld = BigInt(row.tokens_held_wei);
  if (tokensHeld <= 0n) {
    updatePosition(id, { status: "closed", close_reason: reason, error: "no tokens held" });
    return { ok: false, message: "no tokens held" };
  }

  try {
    const state = await getCurveState({
      curve: getAddress(row.curve_address),
      tokenDecimals: row.token_decimals,
      quoteDecimals: row.quote_decimals,
      creatorTaxBps: row.creator_tax_bps,
    });

    if (state.graduated || state.readyToGraduate) {
      updatePosition(id, {
        status: "failed",
        close_reason: "error",
        error:
          "token graduated to a Uniswap v4 pool before exit — sell manually on pons.family (v4 selling not yet supported)",
        last_price: state.price.priceQuote,
        last_checked_at: new Date().toISOString(),
      });
      logEngine("error", `${row.token_symbol} graduated before exit — manual action needed`, id);
      return { ok: false, message: "graduated before exit" };
    }

    const result = await sellOnCurve({
      curve: getAddress(row.curve_address),
      token: getAddress(row.token_address),
      pairToken: getAddress(row.pair_token),
      tokenDecimals: row.token_decimals,
      quoteDecimals: row.quote_decimals,
      feeBps: state.feeBps,
      creatorTaxBps: row.creator_tax_bps,
      reserves: state.reserves,
      slippageBps: row.slippage_bps,
      tokensInWei: tokensHeld,
    });

    const inQ = Number(row.quote_in_wei) / 10 ** row.quote_decimals;
    const outQ = Number(result.filled) / 10 ** row.quote_decimals;
    const realisedPnlPct = inQ > 0 ? ((outQ - inQ) / inQ) * 100 : 0;

    updatePosition(id, {
      status: "closed",
      tokens_held_wei: "0",
      exit_price: result.effectivePrice || state.price.priceQuote,
      quote_out_wei: result.filled.toString(),
      realised_pnl_pct: realisedPnlPct,
      sell_tx: result.hash,
      close_reason: reason,
      last_price: state.price.priceQuote,
      last_checked_at: new Date().toISOString(),
    });
    logEngine(
      "info",
      `SOLD ${row.token_symbol} (${reason}): ${outQ.toFixed(5)} ${row.quote_symbol} back ` +
        `(${realisedPnlPct >= 0 ? "+" : ""}${realisedPnlPct.toFixed(1)}%) tx ${result.hash}`,
      id,
    );
    return { ok: true, message: `sold, ${realisedPnlPct.toFixed(1)}%` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updatePosition(id, {
      status: "failed",
      close_reason: "error",
      error: message,
      last_checked_at: new Date().toISOString(),
    });
    logEngine("error", `SELL FAILED for ${row.token_symbol}: ${message}`, id);
    return { ok: false, message };
  }
}
