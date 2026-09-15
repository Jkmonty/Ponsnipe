import Link from "next/link";
import type { Score } from "@/lib/arcade";
import { EXPLORER } from "@/lib/format";
import { fmtPool, type PoolInfo } from "@/lib/pool";
import type { Pin } from "@/lib/targets";
import BoardCard from "./BoardCard";
import Butt from "./Butt";

/**
 * Copy on the left, the butt and the board on the right.
 *
 * The pins are today's range targets: the shares this chain trades against,
 * green when up on the day and red when down. Real data on the motif, which
 * is the only reason to have a motif.
 */
export default function Hero({
  pins,
  board,
  endsAt,
  pool,
}: {
  pins: Pin[];
  board: Score[];
  endsAt: number;
  pool: PoolInfo | null;
}) {
  return (
    <section className="hero">
      <div className="hero-in">
        <div className="hero-copy">
          <p className="lab sect-lab">Sherwood · Robinhood Chain</p>
          <h1 className="display hero-h1">
            Pick your shot.
            <br />
            <em>Loose it.</em>
            <br />
            Walk away.
          </h1>
          <p className="hero-sub">
            Every pons launch, the second it exists. Exits set before you&apos;re in. And a
            range where today&apos;s tickers are the targets.
          </p>
          <div className="hero-cta">
            <Link href="/range" className="btn btn-primary hbtn">
              Draw the bow
            </Link>
            <a href="#feed" className="btn hbtn ghost">
              Snipe a launch
            </a>
          </div>
          {pool && (
            <p className="hero-pool">
              This week&apos;s pool <b>{fmtPool(pool.eth)}</b> ·{" "}
              <a href={`${EXPLORER}/address/${pool.wallet}`} target="_blank" rel="noopener noreferrer">
                paid from an address anyone can check
              </a>
            </p>
          )}
        </div>

        <div className="hero-side">
          {/*
            The target is the door to the range: one big link, no button on
            it. A handwritten note bobs beside it and says so, inside the same
            link. The button on the left says the same thing for a keyboard
            or a thumb on a phone, where the butt sits faint behind the
            headline and the note is hidden.
          */}
          <Link href="/range" className="butt-link" aria-label="Enter the range">
            <span className="butt-note" aria-hidden="true">
              <span className="butt-note-text">enter the range</span>
              <svg className="butt-note-arrow" viewBox="0 0 120 110" fill="none">
                <path d="M14 6 C 8 40, 10 78, 100 88" />
                <path d="M84 64 L 112 88 L 84 106" />
              </svg>
            </span>
            <Butt className="butt-hero">
              <span className="butt-arrow" />
              {pins.slice(0, 3).map((p, i) => (
                <span key={p.symbol} className={`pin pin-${i + 1} ${p.up ? "pin-up" : "pin-dn"}`}>
                  <i>{p.symbol}</i>
                  {p.changePct >= 0 ? "+" : ""}
                  {p.changePct.toFixed(1)}%
                </span>
              ))}
            </Butt>
          </Link>
          <BoardCard rows={board} endsAt={endsAt} pool={pool} />
        </div>
      </div>
      <div className="trees" aria-hidden="true" />
    </section>
  );
}
