import { EXPLORER, shortAddr } from "@/lib/format";
import { feeWalletAddress } from "@/lib/pool";

const REPO_URL = (process.env.NEXT_PUBLIC_REPO_URL ?? "").trim();
const X_URL = (process.env.NEXT_PUBLIC_X_URL ?? "").trim();

/**
 * One line, mono. Each link appears only when there is somewhere for it to go:
 * the terminal already hides its Source link the same way, and a footer link
 * to nowhere is worse than no link.
 */
export default function SiteFooter() {
  const fee = feeWalletAddress();
  return (
    <footer className="sfoot">
      {X_URL && (
        <a href={X_URL} target="_blank" rel="noopener noreferrer">
          X
        </a>
      )}
      {REPO_URL && (
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
          Source
        </a>
      )}
      {fee && (
        <a
          href={`${EXPLORER}/address/${fee}`}
          target="_blank"
          rel="noopener noreferrer"
          title="The fee wallet. Its balance is the prize pool."
        >
          Fee wallet {shortAddr(fee)}
        </a>
      )}
      {REPO_URL && (
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
          Run your own
        </a>
      )}
      <span className="sfoot-note">Robinhood Chain</span>
    </footer>
  );
}
