"use client";

/**
 * The paper sniper.
 *
 * Eight real launches, replayed one at a time, showing only what was knowable
 * at the moment each one appeared. Snipe or skip. Then it tells you what
 * actually happened, because this index holds the answer.
 *
 * It exists because nobody believes the numbers. Told that half of all
 * launches never trade and the median coin lives three minutes, a trader
 * nods and snipes anyway. Watching themselves lose on six of eight, and then
 * being shown which single rule would have skipped five of them, is an
 * argument that survives contact with optimism.
 *
 * No wallet, no money, no connection required — which also makes it the one
 * part of this app a stranger can use immediately.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Logo from "../Logo";

interface Round {
  symbol: string;
  name: string;
  logo: string;
  quoteSymbol: string;
  socials: string;
  description: string;
  devLaunches: number;
  devGraduated: number;
  devTraded: number;
  outcome: { everTraded: boolean; peak: number; held: number; trades: number };
}

/** What one pretend snipe costs, so the running total is in familiar units. */
const STAKE = 0.01;

/**
 * Would the dev filter have skipped this one?
 *
 * The same test the feed's badge uses: three or more launches, most of which
 * nobody ever bought. Kept identical on purpose — the lesson is worthless if
 * the rule taught here is not the rule on offer.
 */
function devFilterSkips(r: Round): boolean {
  const dead = r.devLaunches - r.devTraded;
  return r.devGraduated === 0 && r.devLaunches >= 3 && dead / r.devLaunches >= 0.6;
}

export default function Play() {
  const [rounds, setRounds] = useState<Round[] | null>(null);
  const [i, setI] = useState(0);
  const [taken, setTaken] = useState<boolean[]>([]);
  const [revealed, setRevealed] = useState(false);

  const deal = useCallback(async () => {
    setRounds(null);
    setI(0);
    setTaken([]);
    setRevealed(false);
    try {
      const r = await fetch("/api/paper?n=8");
      const j = (await r.json()) as { rounds?: Round[] };
      setRounds(j.rounds ?? []);
    } catch {
      setRounds([]);
    }
  }, []);

  useEffect(() => {
    void deal();
  }, [deal]);

  const answer = (snipe: boolean) => {
    setTaken((t) => [...t, snipe]);
    setRevealed(true);
  };

  const next = () => {
    setRevealed(false);
    setI((n) => n + 1);
  };

  if (!rounds) return <main className="play"><p className="play-wait">dealing…</p></main>;
  if (!rounds.length) {
    return (
      <main className="play">
        <p className="play-wait">
          Not enough launches indexed yet. The feed needs to run for a few minutes.
        </p>
      </main>
    );
  }

  const done = i >= rounds.length;
  const r = rounds[Math.min(i, rounds.length - 1)];

  /* Scored on holding, not on the peak. Nobody sells the top, and a game that
     pretends otherwise teaches the wrong lesson. */
  const pnl = rounds.reduce(
    (sum, x, n) => (taken[n] ? sum + STAKE * (x.outcome.held - 1) : sum),
    0,
  );
  const sniped = taken.filter(Boolean).length;
  const wins = rounds.filter((x, n) => taken[n] && x.outcome.held > 1).length;
  const savedByDev = rounds.filter(
    (x, n) => taken[n] && devFilterSkips(x) && x.outcome.held <= 1,
  ).length;

  return (
    <main className="play">
      <header className="play-top">
        <Link href="/" className="play-home">
          <Logo size={26} />
          <span>Ponsnipe</span>
        </Link>
        <span className="play-sub">
          Paper sniper — real launches, replayed. No wallet, no money.
        </span>
      </header>

      {done ? (
        <section className="play-card play-done">
          <h1 className={pnl >= 0 ? "up" : "down"}>
            {pnl >= 0 ? "+" : ""}
            {pnl.toFixed(4)} ETH
          </h1>
          <p className="play-line">
            You sniped {sniped} of {rounds.length}. {wins} made money.
          </p>
          {/*
            The whole reason this exists. A number nobody argues with, followed
            by the one rule that would have changed it.
          */}
          {savedByDev > 0 && (
            <p className="play-lesson">
              <b>{savedByDev}</b> of your losses were launches by a deployer who had
              already made {rounds.find((x, n) => taken[n] && devFilterSkips(x))?.devLaunches}+
              coins that mostly never traded. The dev filter skips those.
            </p>
          )}
          {sniped === 0 && (
            <p className="play-lesson">
              You skipped everything, which beats most people who do not.
            </p>
          )}
          <div className="play-acts">
            <button className="btn btn-primary btn-lg" onClick={() => void deal()}>
              Again
            </button>
            <Link href="/" className="btn btn-lg">
              Do it for real
            </Link>
          </div>
        </section>
      ) : (
        <section className="play-card">
          <div className="play-count">
            {i + 1} / {rounds.length}
          </div>

          <div className="play-coin">
            {r.logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="play-logo"
                src={`/api/img?u=${encodeURIComponent(r.logo)}`}
                alt=""
                onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")}
              />
            ) : (
              <div className="play-logo play-logo-blank" />
            )}
            <div>
              <h2>{r.symbol}</h2>
              <p className="play-name">{r.name}</p>
            </div>
          </div>

          {r.description && <p className="play-desc">{r.description}</p>}

          <ul className="play-facts">
            <li>
              priced in <b>{r.quoteSymbol}</b>
            </li>
            <li>{r.socials ? "has a link" : "no link"}</li>
            <li className={devFilterSkips(r) ? "bad" : ""}>
              {r.devLaunches > 1
                ? `dev has made ${r.devLaunches}, ${r.devTraded} ever traded`
                : "dev's first coin"}
            </li>
          </ul>

          {!revealed ? (
            <>
              <p className="play-ask">Two seconds old. That is everything you get.</p>
              <div className="play-acts">
                <button className="btn btn-primary btn-lg" onClick={() => answer(true)}>
                  Snipe it — {STAKE} ETH
                </button>
                <button className="btn btn-lg" onClick={() => answer(false)}>
                  Skip
                </button>
              </div>
            </>
          ) : (
            <div className="play-reveal">
              <p className={r.outcome.held > 1 ? "up" : "down"}>
                {!r.outcome.everTraded
                  ? "Nobody ever bought it."
                  : `Peaked at ${r.outcome.peak.toFixed(2)}×, ended at ${r.outcome.held.toFixed(2)}× · ${r.outcome.trades} trades`}
              </p>
              {taken[i] && (
                <p className={STAKE * (r.outcome.held - 1) >= 0 ? "up" : "down"}>
                  {STAKE * (r.outcome.held - 1) >= 0 ? "+" : ""}
                  {(STAKE * (r.outcome.held - 1)).toFixed(4)} ETH
                </p>
              )}
              <button className="btn btn-primary btn-lg" onClick={next}>
                {i + 1 >= rounds.length ? "See the damage" : "Next"}
              </button>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
