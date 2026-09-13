import PaperSniper from "../PaperSniper";

/** The paper sniper on its own, for a link that should land on the game. */
export default function PlayPage() {
  return (
    <main className="site-main">
      <section className="sect">
        <p className="lab sect-lab">Paper sniper</p>
        <h1 className="display sect-h2">Eight real launches. Two seconds old each.</h1>
        <p className="sect-sub">Snipe or skip. No wallet, no money. Then it tells you what actually happened.</p>
        <div className="site-paper">
          <PaperSniper />
        </div>
      </section>
    </main>
  );
}
