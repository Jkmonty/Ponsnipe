"use client";

/**
 * The terminal's public view, on the front door.
 *
 * The live feed on the left and the trade panel on the right, wired together
 * the way the terminal wires them: pick a coin in the feed and it loads into
 * the panel; arm a ticker in the panel and the sniper watches the feed for
 * it. Both are the terminal's own components, inside the terminal's own grid
 * and wallet provider, so this renders as the hosted terminal does and nothing
 * in the terminal changes.
 */
import { useState } from "react";
import Feed from "@/app/Feed";
import TradePanel from "@/app/TradePanel";
import WalletButton from "@/app/WalletButton";
import { WalletProvider } from "@/app/WalletContext";

export default function LiveSection() {
  const [picked, setPicked] = useState<{ address: string; n: number } | null>(null);
  const pick = (address: string) => setPicked({ address, n: Date.now() });

  return (
    <section className="sect" id="feed">
      <WalletProvider>
        <div className="live-head">
          <div>
            <p className="lab sect-lab">Live</p>
            <h2 className="display sect-h2">Every pons launch, the second it exists.</h2>
            <p className="sect-sub">
              Pick one to load it into the panel, or name a ticker and arm a snipe before the coin
              exists. Arming one needs a wallet in this browser.
            </p>
          </div>
          <WalletButton />
        </div>
        <div className="cols cols-solo site-cols">
          <Feed onPick={pick} />
          <div className="colside">
            <TradePanel picked={picked} onPickHolding={pick} />
          </div>
        </div>
      </WalletProvider>
    </section>
  );
}
