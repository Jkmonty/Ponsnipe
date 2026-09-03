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
 * How many times a sell may fail before we stop retrying and hand it to the
 * user. A revert on `minQuoteOut` is the MOST likely failure during the dump a
 * stop-loss exists for, so giving up after one attempt would defeat the feature.
 * Each retry re-reads the curve, so the next quote is priced at the new level.
 */
const MAX_SELL_ATTEMPTS = 6;

/** Log a dry-run "would sell" at most this often per position. */
const DRY_RUN_LOG_INTERVAL_MS = 60_000;

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
    // Throttle the log: the trigger stays true every pass until the user arms
    // live trading, which would otherwise flood engine_log several times a second.
    const last = row.last_dry_run_at ? Date.parse(row.last_dry_run_at) : 0;
    const now = Date.now();
    if (now - last > DRY_RUN_LOG_INTERVAL_MS) {
      logEngine("warn", `DRY RUN — would sell ${row.token_symbol} (${reason})`, id);
      updatePosition(id, { last_dry_run_at: new Date(now).toISOString() });
    }
    updatePosition(id, { status: "open", last_checked_at: new Date().toISOString() });
    return { ok: false, message: "dry-run: live trading is off" };
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

    // Permanent: the curve can no longer sell, retrying will never help.
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
      error: null,
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
    const attempts = (row.sell_attempts ?? 0) + 1;

    if (attempts < MAX_SELL_ATTEMPTS) {
      // Back to `open` so the monitor keeps watching and retries on the next
      // pass — re-quoting against the new price. Anything else silently
      // abandons the bag exactly when the stop-loss is most needed.
      updatePosition(id, {
        status: "open",
        sell_attempts: attempts,
        error: `sell attempt ${attempts}/${MAX_SELL_ATTEMPTS} failed: ${message}`,
        last_checked_at: new Date().toISOString(),
      });
      logEngine(
        "warn",
        `sell attempt ${attempts}/${MAX_SELL_ATTEMPTS} failed for ${row.token_symbol}, will retry: ${message}`,
        id,
      );
      return { ok: false, message: `retrying (${attempts}/${MAX_SELL_ATTEMPTS}): ${message}` };
    }

    updatePosition(id, {
      status: "failed",
      sell_attempts: attempts,
      close_reason: "error",
      error: `gave up after ${attempts} sell attempts: ${message}`,
      last_checked_at: new Date().toISOString(),
    });
    logEngine(
      "error",
      `SELL FAILED for ${row.token_symbol} after ${attempts} attempts — manual action needed: ${message}`,
      id,
    );
    return { ok: false, message };
  }
}
