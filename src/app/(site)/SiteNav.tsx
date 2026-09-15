import Link from "next/link";
import Logo from "@/app/Logo";
import Butt from "./Butt";

/**
 * Mark, wordmark, two links.
 *
 * Sniper is the feed and the panel on the front page; Range is the game, with
 * the board beside it. Nothing else: the terminal route shows a visitor the
 * same feed and panel without the hero, so it earns no link, and Connect
 * lives with the panel, where a wallet is useful.
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
        <Link href="/#feed" className="btn btn-primary snav-pill">
          {/* A bow, drawn: the stave as one arc, the string, and an arrow on it. */}
          <svg className="snav-bow" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M5 2 C 14 6, 14 14, 5 18" />
            <path d="M5 2 L 5 18" />
            <path d="M5 10 L 17 10" />
            <path d="M14 7 L 17 10 L 14 13" />
          </svg>
          Sniper
        </Link>
        <Link href="/range" className="btn snav-pill snav-range">
          <Butt size={18} />
          Range
        </Link>
      </nav>
    </header>
  );
}
