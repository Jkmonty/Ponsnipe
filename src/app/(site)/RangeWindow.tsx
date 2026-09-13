import Link from "next/link";
import Butt from "./Butt";

/**
 * A window onto the range, not the range.
 *
 * Three butts at three distances on the forest ground and one button. No
 * canvas, no three.js, no model on this page: a stranger on a phone gets a
 * poster and a door, and the scene loads only once they walk through it.
 */
export default function RangeWindow({ hasPool }: { hasPool: boolean }) {
  return (
    <section className="sect">
      <p className="lab sect-lab">Sherwood Shooting Range</p>
      <h2 className="display sect-h2">Real tickers on the butts.</h2>
      <div className="rwin">
        <Butt className="b1" />
        <Butt className="b2" />
        <Butt className="b3" />
        <div className="trees" aria-hidden="true" />
        <Link href="/range" className="btn btn-primary hbtn rwin-cta">
          Enter the range
        </Link>
      </div>
      <p className="rwin-cap">
        The ones down today shoot back.
        {hasPool && " Best run of the week takes the pool."}
      </p>
    </section>
  );
}
