/**
 * The weekly arcade leaderboard.
 *
 * Scores are posted from a browser, which means they cannot be trusted — a
 * page that can send a number can send any number. This is honest about that
 * rather than pretending otherwise: it stores what it is told, ranks it, and
 * keeps enough alongside each score (how long the run lasted, how many shots,
 * what was hit) that an impossible one is visible to a human before anybody is
 * paid.
 *
 * The alternative — simulating the game server-side — is the only real defence
 * and is an enormous amount of work for a shooting gallery. Worth doing if and
 * when prizes get big enough to be worth cheating for. Until then the honest
 * position is that this is a scoreboard, and a prize paid from it is checked
 * by eye.
 *
 * Weeks run Monday to Monday in UTC, which is the only definition that does
 * not move with whoever is looking at it.
 */
import { db } from "./db";

export interface Score {
  week: string;
  wallet: string;
  name: string;
  points: number;
  hits: number;
  shots: number;
  ms: number;
  at: number;
}

let ready = false;
function ensure(): ReturnType<typeof db> {
  const conn = db();
  if (!ready) {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS arcade_scores (
        week    TEXT NOT NULL,
        wallet  TEXT NOT NULL,
        name    TEXT NOT NULL DEFAULT '',
        points  INTEGER NOT NULL,
        hits    INTEGER NOT NULL DEFAULT 0,
        shots   INTEGER NOT NULL DEFAULT 0,
        ms      INTEGER NOT NULL DEFAULT 0,
        at      INTEGER NOT NULL,
        -- One row per wallet per week, holding their best. A table of every
        -- attempt would rank whoever played most rather than whoever played
        -- best, and the prize is for the second thing.
        PRIMARY KEY (week, wallet)
      );
    `);
    conn.exec(`CREATE INDEX IF NOT EXISTS idx_arcade_rank ON arcade_scores(week, points DESC);`);
    ready = true;
  }
  return conn;
}

/** Monday-to-Monday in UTC — the only week that does not move with the reader. */
export function weekOf(when = new Date()): string {
  const d = new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate()));
  // getUTCDay is 0 on Sunday, which belongs to the week that started six days
  // earlier rather than to the one starting tomorrow.
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/** When the current week ends, in ms. */
export function weekEnds(week = weekOf()): number {
  return Date.parse(`${week}T00:00:00Z`) + 7 * 86_400_000;
}

/**
 * Record a run, keeping only a wallet's best for the week.
 *
 * Returns the score that now stands, which is not always the one just posted —
 * a worse run does not overwrite a better one, and saying so lets the page
 * show "your best is still X" instead of pretending the last go counted.
 */
export function submit(s: Omit<Score, "week" | "at">): { best: number; improved: boolean } {
  const conn = ensure();
  const week = weekOf();
  const wallet = s.wallet.toLowerCase();
  const prev = conn
    .prepare(`SELECT points FROM arcade_scores WHERE week = ? AND wallet = ?`)
    .get(week, wallet) as { points: number } | undefined;

  if (prev && prev.points >= s.points) return { best: prev.points, improved: false };

  conn
    .prepare(
      `INSERT INTO arcade_scores (week, wallet, name, points, hits, shots, ms, at)
         VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(week, wallet) DO UPDATE SET
         name = excluded.name, points = excluded.points, hits = excluded.hits,
         shots = excluded.shots, ms = excluded.ms, at = excluded.at`,
    )
    .run(week, wallet, s.name.slice(0, 24), s.points, s.hits, s.shots, s.ms, Date.now());
  return { best: s.points, improved: true };
}

/** The table, best first. Ties break on who got there first. */
export function top(limit = 100, week = weekOf()): Score[] {
  return ensure()
    .prepare(
      `SELECT week, wallet, name, points, hits, shots, ms, at
         FROM arcade_scores WHERE week = ?
        ORDER BY points DESC, at ASC
        LIMIT ?`,
    )
    .all(week, Math.max(1, Math.min(500, limit))) as unknown as Score[];
}

/** Where one wallet stands this week, or null if they have not played. */
export function rankOf(wallet: string, week = weekOf()): { rank: number; points: number } | null {
  const w = wallet.toLowerCase();
  const mine = ensure()
    .prepare(`SELECT points, at FROM arcade_scores WHERE week = ? AND wallet = ?`)
    .get(week, w) as { points: number; at: number } | undefined;
  if (!mine) return null;
  const ahead = ensure()
    .prepare(
      `SELECT COUNT(*) AS n FROM arcade_scores
        WHERE week = ? AND (points > ? OR (points = ? AND at < ?))`,
    )
    .get(week, mine.points, mine.points, mine.at) as { n: number };
  return { rank: ahead.n + 1, points: mine.points };
}
