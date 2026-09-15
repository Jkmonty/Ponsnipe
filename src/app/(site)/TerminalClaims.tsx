/**
 * Three measured claims.
 *
 * The numbers are the ones the README and the roadmap already make: they are
 * measured, not chosen for this page. The feed and the panel sit higher up,
 * so this section only has to say what the engine under them does.
 */
export default function TerminalClaims() {
  return (
    <section className="sect">
      <p className="lab sect-lab">Under the hood</p>
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
    </section>
  );
}
