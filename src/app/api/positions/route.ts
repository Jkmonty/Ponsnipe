import { z } from "zod";
import { getAddress, isAddress, parseEther } from "viem";
import { json, errorJson, requireAuth } from "@/lib/api";
import { env } from "@/lib/env";
import { getTokenSnapshot } from "@/lib/pons/tokens";
import { buyOnCurve } from "@/lib/pons/swap";
import { findRoute, quoteZap, zapEthToQuote } from "@/lib/pons/zap";
import { hasBotWallet, getBotBalance } from "@/lib/wallet/botWallet";
import { isLive } from "@/lib/engine/liveState";
import { kickMonitor } from "@/lib/engine/monitor";
import { logEngine } from "@/lib/db/index";
import {
  createPosition,
  listPositions,
  unrealisedPnlPct,
  type PositionRow,
} from "@/lib/db/positions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Default graduation exit. Past graduation the bonding curve stops accepting
 * sells and the token only trades in a Uniswap v4 pool, which this engine can't
 * exit yet — so bail out slightly early by default rather than strand a winner.
 */
export const DEFAULT_GRADUATION_EXIT_PCT = 92;

const openSchema = z
  .object({
    tokenAddress: z.string().refine(isAddress, "invalid token address"),
    ethAmount: z
      .string()
      .refine((s) => Number(s) > 0 && Number.isFinite(Number(s)), "ethAmount must be > 0"),
    takeProfitPct: z.number().positive().max(1_000_000).optional(),
    stopLossPct: z.number().positive().max(100).optional(),
    trailingStopPct: z.number().positive().max(100).optional(),
    /** Exit at this % of the way to graduation; null/absent disables. */
    graduationExitPct: z.number().positive().max(100).nullable().optional(),
    slippageBps: z.number().int().min(10).max(5000).optional(),
  })
  .refine(
    (v) => v.takeProfitPct != null || v.stopLossPct != null || v.trailingStopPct != null,
    { message: "set at least one of takeProfitPct / stopLossPct / trailingStopPct" },
  );

function withLivePnl(row: PositionRow) {
  const price = row.last_price ?? row.exit_price ?? row.entry_price;
  const pnlPct =
    row.status === "closed" || row.status === "failed"
      ? row.realised_pnl_pct ?? unrealisedPnlPct(row, price)
      : unrealisedPnlPct(row, price);
  return { ...row, current_price: price, pnl_pct: pnlPct };
}

export async function GET() {
  return json({ positions: listPositions().map(withLivePnl) });
}

export async function POST(req: Request) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorJson("invalid JSON body");
  }
  const parsed = openSchema.safeParse(body);
  if (!parsed.success) {
    return errorJson(parsed.error.issues.map((i) => i.message).join("; "));
  }
  const input = parsed.data;

  if (!hasBotWallet()) {
    return errorJson("bot wallet not set up — run `npm run wallet:init`", 409);
  }

  const token = getAddress(input.tokenAddress);
  const snap = await getTokenSnapshot(token);
  if (snap.venue === "none") {
    return errorJson(snap.reason ?? "token is not a pons v2 launch", 422);
  }
  if (!snap.tradeable || !snap.curve) {
    return errorJson(snap.reason ?? "token is not currently tradeable", 422);
  }
  /*
   * An ERC-20-quoted launch is bought by swapping ETH for its quote asset
   * first. Roughly half of all pons launches are quoted in USDG, NVDA or
   * another tokenised equity, and this path used to refuse all of them.
   *
   * Checked before anything is spent: if no V3 pool exists for the asset there
   * is no way to reach the curve, and saying so now is better than failing
   * between a completed swap and an impossible buy.
   */
  const zapRoute = snap.quoteIsNative ? null : await findRoute(getAddress(snap.pairToken));
  if (!snap.quoteIsNative && !zapRoute) {
    return errorJson(
      `this launch trades against ${snap.quoteSymbol}, and there is no Uniswap V3 pool to buy ${snap.quoteSymbol} with ETH`,
      422,
    );
  }

  const ethWei = parseEther(input.ethAmount);
  const gasBuffer = parseEther("0.0005"); // buy + later sell
  const balance = await getBotBalance();
  const short = balance.ethWei < ethWei + gasBuffer;

  const slippageBps = input.slippageBps ?? env.defaultSlippageBps;

  if (!isLive()) {
    return json({
      dryRun: true,
      message: "ENGINE_LIVE is not set — no buy was sent. Set ENGINE_LIVE=1 to trade for real.",
      preview: {
        token: { address: snap.address, symbol: snap.symbol, name: snap.name },
        curve: snap.curve,
        ethAmount: input.ethAmount,
        entryPrice: snap.price.priceQuote,
        feeBps: snap.feeBps,
        creatorTaxBps: snap.creatorTaxBps,
        graduationProgressPct: snap.graduation.progressPct,
        takeProfitPct: input.takeProfitPct ?? null,
        stopLossPct: input.stopLossPct ?? null,
        trailingStopPct: input.trailingStopPct ?? null,
        slippageBps,
        /*
         * Reported, not enforced.
         *
         * The balance check used to run BEFORE this branch, so a dry run
         * failed with "insufficient balance" on an empty wallet — in the one
         * mode that exists for looking at a trade before committing to it, and
         * against this app's own rule that inspecting a token must work with
         * no funds. It is a fact about the preview now; only the live path
         * below refuses.
         */
        insufficientBalance: short,
        haveEth: balance.eth,
        // What the ETH would turn into before it ever reaches the curve, so a
        // dry run of a USDG-quoted coin shows the extra hop rather than
        // implying the ETH is spent on the curve directly.
        zap: zapRoute
          ? {
              quoteSymbol: snap.quoteSymbol,
              feeTier: zapRoute.fee,
              expectedQuoteOut: (await quoteZap(getAddress(snap.pairToken), ethWei))?.out?.toString() ?? null,
            }
          : null,
      },
    });
  }

  if (short) {
    return errorJson(
      `insufficient balance: have ${balance.eth} ETH, need ~${input.ethAmount} + gas`,
      402,
    );
  }

  try {
    /*
     * Buy the quote asset first when the curve does not take ETH.
     *
     * The amount handed to the curve is what the swap actually delivered, read
     * from the wallet balance either side of it, not what was quoted — sizing
     * the curve buy off an estimate would either leave dust behind or ask the
     * curve for more than we hold.
     */
    let curveInWei = ethWei;
    let zapHash: string | null = null;
    if (!snap.quoteIsNative) {
      const zapped = await zapEthToQuote(getAddress(snap.pairToken), ethWei, slippageBps);
      curveInWei = zapped.received;
      zapHash = zapped.hash;
    }

    const buy = await buyOnCurve({
      curve: getAddress(snap.curve),
      token,
      pairToken: snap.pairToken,
      tokenDecimals: snap.decimals,
      quoteDecimals: snap.quoteDecimals,
      feeBps: snap.feeBps,
      creatorTaxBps: snap.creatorTaxBps,
      reserves: snap.reserves,
      slippageBps,
      quoteInWei: curveInWei,
    });
    if (buy.filled <= 0n) return errorJson("buy returned 0 tokens — aborted", 502);

    // The buy is already on-chain past this point. If recording the position
    // fails, the tokens exist with no stop-loss attached — surface that as
    // something the user must act on, not a generic "buy failed".
    let position;
    try {
      position = createPosition({
        tokenAddress: token,
        tokenSymbol: snap.symbol,
        tokenDecimals: snap.decimals,
        curveAddress: getAddress(snap.curve),
        pairToken: snap.pairToken,
        quoteSymbol: snap.quoteSymbol,
        quoteDecimals: snap.quoteDecimals,
        feeBps: snap.feeBps,
        creatorTaxBps: snap.creatorTaxBps,
        /*
         * The cost basis is in the QUOTE asset, not in ETH.
         *
         * The executor closes a position with
         * `(filled - quote_in_wei) / quote_in_wei`, both sides scaled by
         * quote_decimals — so for a USDG-quoted coin, storing ETH wei here
         * would divide 1e18 by 1e6 and report a profit around a trillion times
         * the truth. For a native-ETH curve the two are the same number.
         */
        quoteInWei: curveInWei,
        tokensHeldWei: buy.filled,
        entryPrice: buy.effectivePrice || snap.price.priceQuote,
        buyTx: buy.hash,
        takeProfitPct: input.takeProfitPct ?? null,
        stopLossPct: input.stopLossPct ?? null,
        trailingStopPct: input.trailingStopPct ?? null,
        graduationExitPct:
          input.graduationExitPct === undefined
            ? DEFAULT_GRADUATION_EXIT_PCT
            : input.graduationExitPct,
        graduationThresholdWei: snap.graduation.thresholdWei,
        slippageBps,
      });
    } catch (persistErr) {
      const pmsg = persistErr instanceof Error ? persistErr.message : String(persistErr);
      logEngine(
        "error",
        `BOUGHT BUT NOT TRACKED — ${buy.filled} units of ${snap.symbol} (${token}) held with ` +
          `NO stop-loss. tx ${buy.hash}. Sell manually. Cause: ${pmsg}`,
      );
      return errorJson(
        `Buy succeeded (tx ${buy.hash}) but the position could not be saved, so it is NOT being ` +
          `monitored and has no stop-loss. Sell it manually. Cause: ${pmsg}`,
        500,
      );
    }

    kickMonitor(); // start watching this position's curve immediately

    // zapTx is null on an ETH-quoted curve; on any other it is the swap that
    // bought the quote asset, and the user needs it to follow their own money.
    return json({ position: withLivePnl(position), buyTx: buy.hash, zapTx: zapHash }, { status: 201 });
  } catch (err) {
    return errorJson(err instanceof Error ? err.message : "buy failed", 502);
  }
}
