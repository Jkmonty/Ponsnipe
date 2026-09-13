import type { Score } from "@/lib/arcade";
import { EXPLORER, shortAddr } from "@/lib/format";
import { fmtPool, type PoolInfo } from "@/lib/pool";

/** "Mon 15 Sep · 00:00 UTC". Always a Monday midnight by construction. */
function endsLabel(endsAt: number): string {
  const d = new Date(endsAt);
  const day = d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  return `${day} · 00:00 UTC`;
}

/**
 * The top of this week's board, and the pool that pays it.
 *
 * The same surface and hairline the terminal uses, because this card is the
 * one honest pitch on the page: a leaderboard with a public wallet under it.
 */
export default function BoardCard({
  rows,
  endsAt,
  pool,
}: {
  rows: Score[];
  endsAt: number;
  pool: PoolInfo | null;
}) {
  return (
    <aside className="board" aria-label="This week's board">
      <div className="board-h lab">
        <span>This week</span>
        <span className="gold">ends {endsLabel(endsAt)}</span>
      </div>
      {rows.length === 0 ? (
        <p className="board-empty">Nobody has posted a score yet.</p>
      ) : (
        rows.slice(0, 3).map((r, i) => (
          <div className="board-row" key={r.wallet}>
            <span className="n mono">{String(i + 1).padStart(2, "0")}</span>
            <span className="w mono">{r.name || shortAddr(r.wallet)}</span>
            <span className="p num">{r.points.toLocaleString("en-GB")}</span>
          </div>
        ))
      )}
      {pool && (
        <div className="board-f mono">
          <span>
            pool <b>{fmtPool(pool.eth)}</b>
          </span>
          <a href={`${EXPLORER}/address/${pool.wallet}`} target="_blank" rel="noopener noreferrer">
            {shortAddr(pool.wallet)} ↗
          </a>
        </div>
      )}
    </aside>
  );
}
