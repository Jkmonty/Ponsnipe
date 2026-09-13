import Link from "next/link";
import type { FeedRow } from "@/lib/feed/query";
import { fmtUsdish, mediaUrl } from "@/lib/format";

function age(min: number): string {
  if (min < 1) return "now";
  if (min < 60) return `${Math.floor(min)}m`;
  return `${Math.floor(min / 60)}h`;
}

/**
 * Three measured claims and the five newest launches, live.
 *
 * The numbers are the ones the README and the roadmap already make: they are
 * measured, not chosen for this page. The strip under them is the feed, read
 * on the server, so a stranger sees the thing the terminal does before being
 * asked to open it.
 */
export default function TerminalStrip({ rows }: { rows: FeedRow[] }) {
  return (
    <section className="sect">
      <p className="lab sect-lab">The terminal</p>
      <h2 className="display sect-h2">Every pons launch, the second it exists.</h2>
      <div className="claims">
        <div className="claim">
          <b className="display">0.09s</b>
          <span className="lab">from launch to indexed</span>
        </div>
        <div className="claim">
          <b className="display">0.2s</b>
          <span className="lab">candle resolution</span>
        </div>
        <div className="claim">
          <b className="display">before entry</b>
          <span className="lab">when the exit is set</span>
        </div>
      </div>
      {rows.length > 0 && (
        <div className="strip" aria-label="Newest launches">
          {rows.map((r) => (
            <div className="strip-row" key={r.token}>
              {r.logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={mediaUrl(r.logo)} alt="" decoding="async" />
              ) : (
                <span />
              )}
              <span className="sym">
                {r.symbol}
                <small>{r.name}</small>
              </span>
              <span className="q mono">{r.quoteSymbol}</span>
              <span className="age mono">{age(r.ageMinutes)}</span>
              <span className="mc num">{r.mcapUsd != null ? `$${fmtUsdish(r.mcapUsd)}` : "—"}</span>
            </div>
          ))}
        </div>
      )}
      <div>
        <Link href="/terminal" className="btn hbtn ghost">
          Open the terminal
        </Link>
      </div>
    </section>
  );
}
