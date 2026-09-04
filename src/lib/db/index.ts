import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "../env";

/**
 * Single shared SQLite connection (built-in `node:sqlite`, no native deps).
 * Both the Next API routes and the in-process monitor loop use this handle.
 */

/**
 * globalThis-backed: Next runs instrumentation and route handlers in separate
 * module registries. A per-registry connection would mean two writers on the
 * same file, so a monitor write racing an API write could throw SQLITE_BUSY
 * mid-trade. One process, one connection.
 */
const gdb = globalThis as typeof globalThis & { __ponsDb?: DatabaseSync };

export function db(): DatabaseSync {
  if (gdb.__ponsDb) return gdb.__ponsDb;
  try {
    mkdirSync(dirname(env.databasePath), { recursive: true });
  } catch {
    /* dir exists */
  }
  const conn = new DatabaseSync(env.databasePath);
  conn.exec("PRAGMA journal_mode = WAL;");
  conn.exec("PRAGMA foreign_keys = ON;");
  conn.exec("PRAGMA busy_timeout = 5000;");
  migrate(conn);
  gdb.__ponsDb = conn;
  return conn;
}

function migrate(conn: DatabaseSync): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      id                TEXT PRIMARY KEY,
      status            TEXT NOT NULL,           -- open | closing | closed | failed | cancelled

      token_address     TEXT NOT NULL,
      token_symbol      TEXT NOT NULL,
      token_decimals    INTEGER NOT NULL,
      curve_address     TEXT NOT NULL,
      pair_token        TEXT NOT NULL,           -- 0x0 = native ETH
      quote_symbol      TEXT NOT NULL,
      quote_decimals    INTEGER NOT NULL,
      fee_bps           INTEGER NOT NULL,
      creator_tax_bps   INTEGER NOT NULL,

      quote_in_wei      TEXT NOT NULL,           -- quote asset put in on the buy
      tokens_held_wei   TEXT NOT NULL,
      entry_price       REAL NOT NULL,           -- token price in quote asset at entry
      buy_tx            TEXT,
      source            TEXT NOT NULL DEFAULT 'manual',  -- manual | sniper

      take_profit_pct   REAL,
      stop_loss_pct     REAL,                    -- stored positive
      trailing_stop_pct REAL,
      -- Exit when the curve is this far toward graduation (%). Past graduation
      -- the curve stops accepting sells, so without this a winner strands.
      graduation_exit_pct    REAL,
      graduation_threshold_wei TEXT,             -- quote units, from the launch record
      slippage_bps      INTEGER NOT NULL,

      peak_price        REAL NOT NULL,
      last_price        REAL,
      last_checked_at   TEXT,

      sell_attempts     INTEGER NOT NULL DEFAULT 0,
      last_dry_run_at   TEXT,

      exit_price        REAL,
      quote_out_wei     TEXT,
      realised_pnl_pct  REAL,
      sell_tx           TEXT,
      close_reason      TEXT,                    -- take_profit | stop_loss | trailing_stop | manual | error
      error             TEXT,

      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
  `);
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);`);

  conn.exec(`
    CREATE TABLE IF NOT EXISTS engine_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT NOT NULL,
      level       TEXT NOT NULL,
      position_id TEXT,
      message     TEXT NOT NULL
    );
  `);

  conn.exec(`
    CREATE TABLE IF NOT EXISTS sniper_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            TEXT NOT NULL,
      token_address TEXT NOT NULL,
      token_symbol  TEXT,
      deployer      TEXT,
      decision      TEXT NOT NULL,       -- bought | skipped | error
      reason        TEXT NOT NULL,
      eth_amount    TEXT,
      buy_tx        TEXT,
      position_id   TEXT
    );
  `);
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_sniper_events_ts ON sniper_events(ts DESC);`);

  /**
   * Columns added after the table shipped, so existing databases need them
   * bolted on. They exist to make the launch feed verifiable at a glance: the
   * quote token a launch pairs against, how much was in its curve and how many
   * others had bought when we looked, and whether it failed our filters or only
   * failed because we cannot buy that quote token yet.
   */
  for (const [col, decl] of [
    ["quote_symbol", "TEXT"],
    ["liquidity", "REAL"],
    ["other_buys", "INTEGER"],
    ["grad_pct", "REAL"],
    // 1 when every filter passed except the ETH-quote requirement — i.e. this
    // is one we would have taken if the zap existed.
    ["blocked_by_quote", "INTEGER"],
  ] as const) {
    try {
      conn.exec(`ALTER TABLE sniper_events ADD COLUMN ${col} ${decl};`);
    } catch {
      /* already present */
    }
  }
}

export interface SniperEventRow {
  id: number;
  ts: string;
  token_address: string;
  token_symbol: string | null;
  deployer: string | null;
  decision: string;
  reason: string;
  eth_amount: string | null;
  buy_tx: string | null;
  position_id: string | null;
  quote_symbol: string | null;
  liquidity: number | null;
  other_buys: number | null;
  grad_pct: number | null;
  blocked_by_quote: number | null;
}

/** Most recent launches the sniper has looked at, newest first. */
export function recentSniperEvents(limit = 100): SniperEventRow[] {
  try {
    return db()
      .prepare(`SELECT * FROM sniper_events ORDER BY id DESC LIMIT ?`)
      .all(Math.max(1, Math.min(500, limit))) as unknown as SniperEventRow[];
  } catch {
    return [];
  }
}

export function logEngine(
  level: "info" | "warn" | "error",
  message: string,
  positionId?: string,
): void {
  try {
    db()
      .prepare(`INSERT INTO engine_log (ts, level, position_id, message) VALUES (?, ?, ?, ?)`)
      .run(new Date().toISOString(), level, positionId ?? null, message);
  } catch {
    /* logging must never throw */
  }
  const tag = positionId ? `[${positionId.slice(0, 8)}]` : "";
  // eslint-disable-next-line no-console
  console[level === "error" ? "error" : "log"](`engine ${tag} ${message}`);
}

/** Trim the log so it doesn't grow forever on a long-running local instance. */
export function pruneEngineLog(keep = 2000): void {
  try {
    db()
      .prepare(
        `DELETE FROM engine_log WHERE id NOT IN (SELECT id FROM engine_log ORDER BY id DESC LIMIT ?)`,
      )
      .run(keep);
  } catch {
    /* ignore */
  }
}
