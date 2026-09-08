"use client";

/**
 * The tape: launches scrolling past, under the header.
 *
 * There was dead space between the header and the feed. A tape is the one
 * animated thing a trading terminal has always had, and it earns the room
 * because it is peripheral vision — you catch a ticker going past while you
 * are reading something else, which is exactly what the space above a feed is
 * for.
 *
 * It reads the same endpoint the feed does, so there is no new query, no
 * second source of truth, and nothing that can disagree with the rows below.
 *
 * It pauses on hover, because a name you want to read should not slide away
 * from you, and it stops entirely for anyone who has asked for reduced motion.
 */
import { useEffect, useRef, useState } from "react";

interface Item {
  token: string;
  symbol: string;
  mcapUsd: number | null;
  ageMinutes: number;
}

/** How often the tape re-reads. Slower than the feed: it is ambient. */
const REFRESH_MS = 15_000;
const COUNT = 22;

function cap(n: number | null): string {
  if (!n) return "—";
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

export default function TickerTape({ onPick }: { onPick: (address: string) => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const stop = useRef(false);

  useEffect(() => {
    stop.current = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/feed?limit=${COUNT}`);
        const j = (await r.json()) as { rows?: Item[] };
        if (!stop.current) setItems((j.rows ?? []).slice(0, COUNT));
      } catch {
        /* the tape simply does not update; it is not worth an error state */
      }
    };
    void load();
    const iv = setInterval(load, REFRESH_MS);
    return () => {
      stop.current = true;
      clearInterval(iv);
    };
  }, []);

  // Nothing to scroll yet: render nothing rather than an empty moving bar.
  if (items.length === 0) return null;

  /*
   * The list is rendered twice.
   *
   * The animation translates the track by exactly half its width, so the
   * second copy is arriving as the first leaves and the loop has no seam. The
   * duplicate is hidden from screen readers — it is the same information said
   * twice for a visual trick.
   */
  const run = (hidden: boolean) =>
    items.map((it) => (
      <button
        key={`${hidden ? "b" : "a"}-${it.token}`}
        className="tape-item"
        type="button"
        tabIndex={hidden ? -1 : 0}
        aria-hidden={hidden || undefined}
        onClick={() => onPick(it.token)}
        title={`${it.symbol} — ${cap(it.mcapUsd)}`}
      >
        {it.ageMinutes < 1 && <i className="tape-new" />}
        <b>{it.symbol}</b>
        <span>{cap(it.mcapUsd)}</span>
      </button>
    ));

  return (
    <div className="tape" aria-label="Recent launches">
      <span className="tape-label">
        <i className="tape-dot" />
        Live
      </span>
      <div className="tape-window">
        <div className="tape-track">
          {run(false)}
          {run(true)}
        </div>
      </div>
    </div>
  );
}
