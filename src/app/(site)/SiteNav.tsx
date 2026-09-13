import Link from "next/link";
import Logo from "@/app/Logo";

/**
 * Mark, wordmark, four links, one button.
 *
 * No Connect here: the landing page has nothing for a wallet to do. The one
 * button-styled item is the terminal, which is where a wallet becomes useful.
 * On narrow screens the middle collapses to Range, Play, Terminal.
 */
export default function SiteNav() {
  return (
    <header className="snav">
      <Link href="/" className="snav-lockup" aria-label="Ponsnipe, front door">
        <Logo size={30} />
        <img
          className="snav-word"
          src="/brand/wordmark.webp"
          srcSet="/brand/wordmark.webp 1x, /brand/wordmark@2x.webp 2x"
          alt="Ponsnipe"
          decoding="async"
        />
      </Link>
      <nav className="snav-links" aria-label="Site">
        <Link href="/range">Range</Link>
        <Link href="/play">
          <span className="snav-long">Paper sniper</span>
          <span className="snav-short">Play</span>
        </Link>
        <Link href="/range#board" className="snav-board">
          Board
        </Link>
        <Link href="/terminal" className="btn btn-sm snav-cta">
          Terminal
        </Link>
      </nav>
    </header>
  );
}
