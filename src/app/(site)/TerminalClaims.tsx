import Link from "next/link";

/**
 * Three measured claims, and the door to the full app.
 *
 * The numbers are the ones the README and the roadmap already make: they are
 * measured, not chosen for this page. The feed itself sits higher up, so this
 * section only has to say what the terminal does that the feed cannot show.
 */
export default function TerminalClaims() {
  return (
    <section className="sect">
      <p className="lab sect-lab">The terminal</p>
      <h2 className="display sect-h2">Measured, not promised.</h2>
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
      <div>
        <Link href="/terminal" className="btn hbtn ghost">
          Open the terminal
        </Link>
      </div>
    </section>
  );
}
