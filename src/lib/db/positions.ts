import { randomUUID } from "node:crypto";
import type { Address } from "viem";
import { db } from "./index";

export type PositionStatus = "open" | "closing" | "closed" | "failed" | "cancelled";

export type CloseReason =
  | "take_profit"
  | "stop_loss"
  | "trailing_stop"
  | "manual"
  | "error";

export interface PositionRow {
  id: string;
  status: PositionStatus;

  token_address: string;
  token_symbol: string;
  token_decimals: number;
  curve_address: string;
  pair_token: string;
  quote_symbol: string;
  quote_decimals: number;
  fee_bps: number;
  creator_tax_bps: number;

  quote_in_wei: string;
  tokens_held_wei: string;
  entry_price: number;
  buy_tx: string | null;
  source: "manual" | "sniper";

  take_profit_pct: number | null;
  stop_loss_pct: number | null;
  trailing_stop_pct: number | null;
  slippage_bps: number;

  peak_price: number;
  last_price: number | null;
  last_checked_at: string | null;

  exit_price: number | null;
  quote_out_wei: string | null;
  realised_pnl_pct: number | null;
  sell_tx: string | null;
  close_reason: CloseReason | null;
  error: string | null;

  created_at: string;
  updated_at: string;
}

export interface NewPosition {
  tokenAddress: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  curveAddress: Address;
  pairToken: Address;
  quoteSymbol: string;
  quoteDecimals: number;
  feeBps: number;
  creatorTaxBps: number;
  quoteInWei: bigint;
  tokensHeldWei: bigint;
  entryPrice: number;
  buyTx: string;
  source?: "manual" | "sniper";
  takeProfitPct: number | null;
  stopLossPct: number | null;
  trailingStopPct: number | null;
  slippageBps: number;
}

export function createPosition(p: NewPosition): PositionRow {
  const now = new Date().toISOString();
  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO positions (
        id, status,
        token_address, token_symbol, token_decimals, curve_address, pair_token,
        quote_symbol, quote_decimals, fee_bps, creator_tax_bps,
        quote_in_wei, tokens_held_wei, entry_price, buy_tx, source,
        take_profit_pct, stop_loss_pct, trailing_stop_pct, slippage_bps,
        peak_price, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      "open",
      p.tokenAddress.toLowerCase(),
      p.tokenSymbol,
      p.tokenDecimals,
      p.curveAddress.toLowerCase(),
      p.pairToken.toLowerCase(),
      p.quoteSymbol,
      p.quoteDecimals,
      p.feeBps,
      p.creatorTaxBps,
      p.quoteInWei.toString(),
      p.tokensHeldWei.toString(),
      p.entryPrice,
      p.buyTx,
      p.source ?? "manual",
      p.takeProfitPct,
      p.stopLossPct,
      p.trailingStopPct,
      p.slippageBps,
      p.entryPrice,
      now,
      now,
    );
  return getPosition(id)!;
}

export function getPosition(id: string): PositionRow | undefined {
  return db().prepare(`SELECT * FROM positions WHERE id = ?`).get(id) as unknown as
    | PositionRow
    | undefined;
}

export function listPositions(status?: PositionStatus): PositionRow[] {
  if (status) {
    return db()
      .prepare(`SELECT * FROM positions WHERE status = ? ORDER BY created_at DESC`)
      .all(status) as unknown as PositionRow[];
  }
  return db()
    .prepare(`SELECT * FROM positions ORDER BY created_at DESC`)
    .all() as unknown as PositionRow[];
}

export function listOpenPositions(): PositionRow[] {
  return db()
    .prepare(
      `SELECT * FROM positions WHERE status IN ('open','closing') ORDER BY created_at ASC`,
    )
    .all() as unknown as PositionRow[];
}

export function updatePosition(id: string, patch: Partial<PositionRow>): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => (patch as Record<string, unknown>)[k]);
  db()
    .prepare(`UPDATE positions SET ${set}, updated_at = ? WHERE id = ?`)
    .run(...(values as never[]), new Date().toISOString(), id);
}

/**
 * Atomically claim a position for closing so the monitor never double-sells.
 * Returns true if this call is the one that flipped open -> closing.
 */
export function claimForClosing(id: string): boolean {
  const res = db()
    .prepare(
      `UPDATE positions SET status = 'closing', updated_at = ?
       WHERE id = ? AND status = 'open'`,
    )
    .run(new Date().toISOString(), id);
  return res.changes === 1;
}

export function countOpenBySource(source: "manual" | "sniper"): number {
  const r = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM positions WHERE source = ? AND status IN ('open','closing')`,
    )
    .get(source) as { n: number };
  return r?.n ?? 0;
}

export function unrealisedPnlPct(row: PositionRow, currentPrice: number): number {
  if (!row.entry_price) return 0;
  return ((currentPrice - row.entry_price) / row.entry_price) * 100;
}
