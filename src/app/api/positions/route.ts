import { z } from "zod";
import { getAddress, isAddress, parseEther } from "viem";
import { json, errorJson, requireAuth } from "@/lib/api";
import { env } from "@/lib/env";
import { getTokenSnapshot } from "@/lib/pons/tokens";
import { buyOnCurve } from "@/lib/pons/swap";
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

const openSchema = z
  .object({
    tokenAddress: z.string().refine(isAddress, "invalid token address"),
    ethAmount: z
      .string()
      .refine((s) => Number(s) > 0 && Number.isFinite(Number(s)), "ethAmount must be > 0"),
    takeProfitPct: z.number().positive().max(1_000_000).optional(),
    stopLossPct: z.number().positive().max(100).optional(),
    trailingStopPct: z.number().positive().max(100).optional(),
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
  if (!snap.quoteIsNative) {
    // The bot wallet funds itself with native ETH; ERC-20-quoted launches would
    // need the wallet pre-funded with that token. Out of scope for v1.
    return errorJson(
      `this launch trades against ${snap.quoteSymbol}, not native ETH — not supported yet`,
      422,
    );
  }

  const ethWei = parseEther(input.ethAmount);
  const balance = await getBotBalance();
  const gasBuffer = parseEther("0.0005"); // buy + later sell
  if (balance.ethWei < ethWei + gasBuffer) {
    return errorJson(
      `insufficient balance: have ${balance.eth} ETH, need ~${input.ethAmount} + gas`,
      402,
    );
  }

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
      },
    });
  }

  try {
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
      quoteInWei: ethWei,
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
        quoteInWei: ethWei,
        tokensHeldWei: buy.filled,
        entryPrice: buy.effectivePrice || snap.price.priceQuote,
        buyTx: buy.hash,
        takeProfitPct: input.takeProfitPct ?? null,
        stopLossPct: input.stopLossPct ?? null,
        trailingStopPct: input.trailingStopPct ?? null,
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

    return json({ position: withLivePnl(position), buyTx: buy.hash }, { status: 201 });
  } catch (err) {
    return errorJson(err instanceof Error ? err.message : "buy failed", 502);
  }
}
