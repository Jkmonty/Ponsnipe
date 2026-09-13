"use client";

/**
 * The tuning bench.
 *
 * An unlisted page for picking how the range sounds. It exists because the
 * person building this cannot hear it: describing a sound in a message and
 * getting "not good" back is a slow, blind loop, whereas four buttons and an
 * ear settle it in ten seconds.
 *
 * It plays the game's own Sfx instance through the game's own spec player, so
 * there is no separate copy of the synthesis to drift out of step — what is
 * auditioned here is exactly what a round will play. The choice is saved in
 * this browser and picked up by the next round.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Logo from "../../Logo";
import { Sfx } from "../sfx";
import {
  LOOSES,
  MARKERS,
  THUNKS,
  DEFAULT_PICKS,
  loadPicks,
  savePicks,
  type Picks,
  type Variant,
} from "../kit";

type Row = {
  key: keyof Picks;
  title: string;
  blurb: string;
  /** Play variant `i`, given the audio engine. */
  play: (s: Sfx, i: number) => void;
  variants: { id: string; label: string; note: string }[];
};

const ROWS: Row[] = [
  {
    key: "marker",
    title: "Hit marker",
    blurb:
      "The tick that confirms a hit. Wants to be short, dry and bright enough to cut through everything else.",
    play: (s, i) => s.playSpec((MARKERS as Variant<[boolean]>[])[i].build(false)),
    variants: MARKERS,
  },
  {
    key: "loose",
    title: "Loosing an arrow",
    blurb: "The string, the stave behind it, and the shaft leaving the rest.",
    play: (s, i) => s.playSpec(LOOSES[i].build()),
    variants: LOOSES,
  },
  {
    key: "thunk",
    title: "Arrow landing",
    blurb:
      "Fires at the same instant as the marker, so its job is to be felt without being heard over it.",
    play: (s, i) => s.playSpec(THUNKS[i].build()),
    variants: THUNKS,
  },
];

export default function SoundBench() {
  const sfxRef = useRef<Sfx | null>(null);
  const [picks, setPicks] = useState<Picks>(DEFAULT_PICKS);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);

  useEffect(() => setPicks(loadPicks()), []);

  /** Audio cannot start without a gesture, so every button goes through here. */
  const engine = useCallback((): Sfx => {
    sfxRef.current ??= new Sfx();
    sfxRef.current.resume();
    sfxRef.current.picks = picks;
    // The same handle the range exposes, for the same reason: a sound can be
    // rendered offline and measured from here, which is the only way to check
    // audio without being able to hear it.
    (window as unknown as { __bench?: Sfx }).__bench = sfxRef.current;
    setReady(true);
    return sfxRef.current;
  }, [picks]);

  useEffect(() => () => sfxRef.current?.close(), []);

  const flash = (id: string) => {
    setPlaying(id);
    setTimeout(() => setPlaying((p) => (p === id ? null : p)), 260);
  };

  const choose = (key: keyof Picks, i: number) => {
    const next = { ...picks, [key]: i };
    setPicks(next);
    savePicks(next);
    const s = engine();
    s.picks = next;
  };

  return (
    <main className="bench">
      <header className="bench-top">
        <Link href="/arcade" className="bench-home">
          <Logo size={26} />
          <span>Sherwood Shooting Range</span>
        </Link>
        <span className="bench-sub">
          Sound bench — pick one of each. Saved in this browser and used by the
          next round.
        </span>
      </header>

      {ROWS.map((row) => (
        <section className="bench-row" key={row.key}>
          <h2>{row.title}</h2>
          <p className="bench-blurb">{row.blurb}</p>
          <div className="bench-opts">
            {row.variants.map((v, i) => {
              const id = `${row.key}:${v.id}`;
              const chosen = picks[row.key] === i;
              return (
                <div className={`bench-opt${chosen ? " chosen" : ""}`} key={v.id}>
                  <button
                    className={`bench-play${playing === id ? " lit" : ""}`}
                    onClick={() => {
                      row.play(engine(), i);
                      flash(id);
                    }}
                  >
                    <span className="bench-label">{v.label}</span>
                    <span className="bench-note">{v.note}</span>
                  </button>
                  <button
                    className="bench-pick"
                    onClick={() => choose(row.key, i)}
                    disabled={chosen}
                  >
                    {chosen ? "in use" : "use this"}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      <section className="bench-row">
        <h2>In context</h2>
        <p className="bench-blurb">
          {/*
            The single most useful button here. Each sound in isolation says
            very little — the question that matters is whether the tick still
            cuts through when the arrow lands underneath it at the same moment,
            which is the only way it is ever actually heard.
          */}
          The way you will really hear them: all at once, as a round plays them.
        </p>
        <div className="bench-opts">
          <button
            className="btn btn-primary btn-lg"
            onClick={() => {
              const s = engine();
              s.loose();
              setTimeout(() => {
                s.thunk();
                s.marker(false);
              }, 260);
            }}
          >
            Shoot and hit
          </button>
          <button
            className="btn btn-lg"
            onClick={() => {
              const s = engine();
              s.loose();
              setTimeout(() => {
                s.thunk();
                s.marker(true);
              }, 260);
            }}
          >
            Shoot and kill a red
          </button>
          <button
            className="btn btn-lg"
            onClick={() => {
              const s = engine();
              s.loose();
              setTimeout(() => s.miss(), 200);
            }}
          >
            Shoot and miss
          </button>
          <button className="btn btn-lg" onClick={() => engine().hurt()}>
            Take an arrow
          </button>
          <button className="btn btn-lg" onClick={() => engine().chime(5)}>
            Five in a row
          </button>
          <button className="btn btn-lg" onClick={() => engine().horn()}>
            End of round
          </button>
        </div>
        {!ready && (
          <p className="bench-hint">
            Press anything to start audio — browsers will not open an audio
            context until you do.
          </p>
        )}
      </section>

      <section className="bench-row">
        <Link href="/arcade" className="btn btn-primary btn-lg">
          Back to the range
        </Link>
      </section>
    </main>
  );
}
