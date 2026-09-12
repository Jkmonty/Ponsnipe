"use client";

/**
 * What the quote asset pays you for holding it.
 *
 * Over four in ten pons launches are priced against a tokenised share, and
 * those shares pass their dividends through as an ERC-8056 multiplier rather
 * than as a payment — nothing arrives in a wallet, the tokens simply come to
 * represent more of the underlying. So a trader in one of those positions is
 * collecting dividend equivalents with no way to notice.
 *
 * Shown next to the coin rather than on a page of its own, because it is a
 * fact about the position being looked at and not a feature to go and find.
 */
import { useEffect, useState } from "react";

interface Asset {
  symbol: string;
  accruedPct: number;
  multiplier: number;
  pending: { multiplier: number; effectiveAt: number | null } | null;
}

/** One fetch per tab, shared: the answer changes quarterly, not per render. */
let shared: Promise<Asset[]> | null = null;
function load(): Promise<Asset[]> {
  shared ??= fetch("/api/dividends")
    .then((r) => r.json())
    .then((j: { assets?: Asset[] }) => j.assets ?? [])
    .catch(() => []);
  return shared;
}

const when = (ms: number | null) =>
  ms == null ? "soon" : new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export default function Dividend({ symbol }: { symbol: string }) {
  const [asset, setAsset] = useState<Asset | null>(null);

  useEffect(() => {
    let live = true;
    void load().then((list) => {
      if (!live) return;
      setAsset(list.find((a) => a.symbol.toUpperCase() === symbol.toUpperCase()) ?? null);
    });
    return () => {
      live = false;
    };
  }, [symbol]);

  // Nothing to say about a stablecoin, or about a share that has not paid yet.
  if (!asset || (asset.accruedPct <= 0 && !asset.pending)) return null;

  return (
    <div className="divi">
      <span className="divi-tag">{asset.symbol} dividend</span>
      {asset.accruedPct > 0 && (
        <span className="divi-val">
          +{asset.accruedPct.toFixed(3)}%<i> paid to holders since listing</i>
        </span>
      )}
      {asset.pending && (
        /* The half worth knowing in advance: the contract publishes the next
           adjustment and when it lands, so this is readable before it happens
           rather than only after. */
        <span className="divi-next">next {when(asset.pending.effectiveAt)}</span>
      )}
    </div>
  );
}
