"use client";

/**
 * What the trader is holding, and what it is worth now.
 *
 * The panel could only ever show the one coin you had just clicked, so a
 * trader who bought three had no way to see the other two — a trading terminal
 * that cannot answer "what do I hold" is half a product.
 *
 * Holdings are found from a local record of what this browser bought rather
 * than by scanning the chain: there is no index of "tokens this address owns"
 * to query, and checking every coin in the feed would be 250 balance calls a
 * refresh. The record is per trading key, so a different wallet in the same
 * browser does not inherit someone else's list.
 *
 * The record is a convenience, not the truth. Balances are read from the chain
 * every refresh, so a row whose balance has gone is dropped whatever the record
 * says — selling elsewhere, or clearing site data, cannot make this lie about
 * what is held. What it does lose with site data is the cost basis, and
 * therefore the profit column; the holding itself reappears the moment the
 * balance is read.
 */
import { useCallback, useEffect, useState } from "react";
import { formatUnits, getAddress, type Address } from "viem";
import { bondingCurveAbi, erc20Abi } from "@/lib/pons/abis";
import { priceFromReserves } from "@/lib/pons/pricing";
import { browserPublic } from "./browserTrade";

const STORE = "ponsnipe.positions.v1";

/** What a buy leaves behind so its profit can be worked out later. */
export interface PositionRecord {
  token: string;
  curve: string;
  symbol: string;
  decimals: number;
  quoteSymbol: string;
  quoteDecimals: number;
  quoteIsNative: boolean;
  /** Quote-asset units spent on the curve, as a string to survive JSON. */
  spentQuote: string;
  /** ETH actually parted with, which for a zapped buy is not the same thing. */
  spentEth: string;
  at: number;
}

export interface Holding extends PositionRecord {
  balance: bigint;
  /** Current worth in the curve's quote asset. */
  valueQuote: number;
  spentQuoteNum: number;
  /** Percent, or null when there is no cost basis to compare against. */
  pnlPct: number | null;
}

type Store = Record<string, PositionRecord[]>;

function readAll(): Store {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "{}") as Store;
  } catch {
    return {};
  }
}

/** Remember a buy. Keyed by the wallet that made it. */
export function recordBuy(owner: Address, rec: PositionRecord): void {
  try {
    const all = readAll();
    const key = owner.toLowerCase();
    const list = all[key] ?? [];
    const existing = list.find((p) => p.token.toLowerCase() === rec.token.toLowerCase());
    if (existing) {
      // Buying more of the same coin adds to the basis rather than replacing
      // it, or the second purchase would erase the first one's cost.
      existing.spentQuote = (BigInt(existing.spentQuote) + BigInt(rec.spentQuote)).toString();
      existing.spentEth = (BigInt(existing.spentEth) + BigInt(rec.spentEth)).toString();
      existing.at = rec.at;
    } else {
      list.push(rec);
    }
    all[key] = list;
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch {
    /* private mode: holdings still show, the cost basis just will not persist */
  }
}

export function forgetPosition(owner: Address, token: string): void {
  try {
    const all = readAll();
    const key = owner.toLowerCase();
    all[key] = (all[key] ?? []).filter((p) => p.token.toLowerCase() !== token.toLowerCase());
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch {
    /* nothing to do */
  }
}

export function usePositions(owner: Address | null, refreshKey: number) {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!owner) return setHoldings([]);
    const recs = readAll()[owner.toLowerCase()] ?? [];
    if (!recs.length) return setHoldings([]);
    setLoading(true);
    try {
      /*
       * One multicall for every balance and every curve's reserves.
       *
       * Multicall3 is deployed on this chain, so a dozen holdings cost one
       * round trip rather than two dozen — which matters on a panel that
       * refreshes after every trade.
       */
      const res = await browserPublic().multicall({
        contracts: recs.flatMap((r) => [
          {
            address: getAddress(r.token),
            abi: erc20Abi,
            functionName: "balanceOf" as const,
            args: [owner],
          },
          {
            address: getAddress(r.curve),
            abi: bondingCurveAbi,
            functionName: "getReserves" as const,
          },
        ]),
        allowFailure: true,
      });

      const out: Holding[] = [];
      recs.forEach((r, i) => {
        const bal = res[i * 2];
        const rv = res[i * 2 + 1];
        if (bal?.status !== "success") return;
        const balance = bal.result as bigint;
        // Gone means gone: sold here, sold elsewhere, or never arrived.
        if (balance <= 0n) return;

        let valueQuote = 0;
        if (rv?.status === "success") {
          const [q, t] = rv.result as readonly [bigint, bigint];
          // Argument order is (reserves, tokenDecimals, quoteDecimals). Both
          // are numbers, so getting them the wrong way round typechecks
          // perfectly and silently misprices every holding — which it did,
          // until the signature was read rather than assumed.
          const price = priceFromReserves(
            { quoteReserve: q, tokenReserve: t },
            r.decimals,
            r.quoteDecimals,
          ).priceQuote;
          valueQuote = Number(formatUnits(balance, r.decimals)) * price;
        }
        const spentQuoteNum = Number(formatUnits(BigInt(r.spentQuote), r.quoteDecimals));
        out.push({
          ...r,
          balance,
          valueQuote,
          spentQuoteNum,
          pnlPct: spentQuoteNum > 0 ? ((valueQuote - spentQuoteNum) / spentQuoteNum) * 100 : null,
        });
      });
      out.sort((a, b) => b.at - a.at);
      setHoldings(out);
    } catch {
      // A failed read must not empty the list on screen — showing nothing
      // would read as "you sold everything", which is a frightening lie.
    } finally {
      setLoading(false);
    }
  }, [owner]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return { holdings, loading, reload: load };
}
