import Link from "next/link";
import Logo from "@/app/Logo";

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
        <Link href="/#feed">Sniper</Link>
        <Link href="/range">Range</Link>
      </nav>
    </header>
  );
}
