/**
 * Three figures from docs/FINDINGS.md, and one sentence.
 *
 * This follows the rule in docs/POSTS.md: it describes what the tool does and
 * never implies a return. If a number here changes, it changes in FINDINGS
 * first.
 */
export default function HonestNumbers() {
  return (
    <section className="sect">
      <p className="lab sect-lab">The honest part</p>
      <div className="honest">
        <div>
          <b className="display">~2%</b>
          <span>of launches ever graduate</span>
        </div>
        <div>
          <b className="display">−32%</b>
          <span>the median graduate, one hour after migration</span>
        </div>
        <div>
          <b className="display">0 of 9</b>
          <span>exit rules on which sniping every launch made money</span>
        </div>
      </div>
      <p className="sect-sub">
        This tool cannot change that. It can only make sure you exit on a rule rather than on a
        feeling.
      </p>
    </section>
  );
}
