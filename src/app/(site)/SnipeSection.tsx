"use client";

/**
 * The live site's right column, on the front door.
 *
 * The trade panel is one machine: arming a watch, buying the moment the
 * ticker exists, and the take-profit and stop-loss that follow all share one
 * buy path and one wallet. Lifting the snipe card out on its own would leave
 * an armed watch with nothing to buy with, so the whole panel comes, inside
 * the same provider and the same column the terminal gives it. Nothing in the
 * terminal changes; this is reuse, not a copy.
 *
 * The sniper polls the feed itself, so the feed does not need to be on the
 * page for a watch to fire.
 */
import TradePanel from "@/app/TradePanel";
import WalletButton from "@/app/WalletButton";
import { WalletProvider } from "@/app/WalletContext";

export default function SnipeSection() {
  return (
    <section className="sect" id="snipe">
      <WalletProvider>
        <div className="snipe-head">
          <div>
            <p className="lab sect-lab">Snipe a launch</p>
            <h2 className="display sect-h2">Name the ticker. It buys the moment that coin exists.</h2>
            <p className="sect-sub">
              Set the exit before you are in. Arming one needs a wallet in this browser.
            </p>
          </div>
          <WalletButton />
        </div>
        <div className="colside site-snipe">
          <TradePanel picked={null} />
        </div>
      </WalletProvider>
    </section>
  );
}
