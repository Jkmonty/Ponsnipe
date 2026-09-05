import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { env } from "../env";

/**
 * Sniper configuration — persisted to data/sniper.json so it survives restarts
 * and can be edited from the UI without touching .env.
 */

export const sniperConfigSchema = z.object({
  enabled: z.boolean(),

  /** ETH spent per snipe. */
  ethAmount: z.string(),

  /** Exit targets handed to the auto-sell engine for every sniped position. */
  takeProfitPct: z.number().positive().max(1_000_000).nullable(),
  stopLossPct: z.number().positive().max(100).nullable(),
  trailingStopPct: z.number().positive().max(100).nullable(),
  /**
   * Exit when the curve is this far toward graduation. Past graduation the
   * curve stops accepting sells, so a sniped winner that runs to the threshold
   * would otherwise be stranded. null disables.
   */
  graduationExitPct: z.number().positive().max(100).nullable(),
  slippageBps: z.number().int().min(10).max(5000),

  /**
   * Seconds to wait after a launch before buying.
   *
   * The anti-snipe tax really is only 3 seconds — pons says so on its launch
   * form and our event data agrees (9900bps at +0.7s, 119bps at +2.4s, 99bps
   * at +3.5s). So this was dropped to 4s on the reasoning that the extra 16
   * seconds were being paid for in price.
   *
   * A scan of the same five days at both delays says otherwise. 4s was WORSE
   * on every exit rule — trail25 -2.2% against -2.1%, balanced -6.0% against
   * -5.2%, hold -10.1% against -8.1% — and the medians degraded much further
   * than the means. Win rate rose while returns fell: more small wins, bigger
   * losses.
   *
   * The delay is therefore NOT an anti-tax measure, it is an OBSERVATION
   * WINDOW. Waiting is what lets us see whether anyone else bought, and that
   * is the strongest signal in the dataset: 8+ other buyers in the first 20s
   * graduate at 5.65% against 0.11% for none. Buying 16 seconds cheaper and
   * blind costs more than it saves.
   */
  delaySeconds: z.number().int().min(0).max(600),

  /** Curve's real ETH reserve at buy time must be within this band. null = no bound. */
  minLiquidityEth: z.number().nonnegative().nullable(),
  maxLiquidityEth: z.number().positive().nullable(),

  /** Reject launches whose permanent creator tax exceeds this (bps). */
  maxCreatorTaxBps: z.number().int().min(0).max(2000),

  /** Require at least this many *other* buys on the curve during the delay window. */
  minOtherBuys: z.number().int().min(0).max(1000),

  /**
   * Require at least this many buys per second during the delay window.
   * Distinguishes "3 buyers spread over 20s" from "3 buyers in the last 2s" —
   * i.e. momentum rather than a trickle. null disables.
   */
  minBuyVelocity: z.number().nonnegative().max(100).nullable(),

  /** Symbol/name must match this (case-insensitive regex). null = any. */
  nameAllowRegex: z.string().nullable(),
  /** Symbol/name must NOT match this. null = no filter. */
  nameDenyRegex: z.string().nullable(),

  /**
   * Reject a deployer that has this many prior launches with NONE graduated.
   *
   * Measured over 110k launches: a first-ever launch graduates at 1.91%, but a
   * deployer with 20+ prior launches and no graduate manages 0.17% — 11x worse
   * than baseline. The reverse carries no signal ("has a prior graduate" runs at
   * 1.50% against a 1.46% baseline), so there is deliberately no whitelist knob
   * here. Needs data/reputation.sqlite; null disables.
   */
  maxDeployerDudLaunches: z.number().int().min(1).max(1000).nullable(),

  /**
   * Require this many of the curve's existing buyers to have already been early
   * on a token that graduated.
   *
   * The only filter in testing that moved a book from negative to positive:
   * 4+ proven buyers took the 1-2 ETH liquidity band from -3.4% to +1.89%, with
   * the graduation rate rising 2.39% -> 3.32%. Thin, and its confidence interval
   * touched zero, so treat it as the best available edge rather than a sure one.
   * Needs data/reputation.sqlite; 0 disables.
   */
  minProvenBuyers: z.number().int().min(0).max(50),

  /**
   * Keep evaluating launches while the sniper is off, so it can suggest what it
   * WOULD have bought without buying anything.
   *
   * Costs two RPC calls per launch at roughly 24k launches a day, so it is a
   * choice rather than a default someone discovers on their bill.
   */
  watchWhenDisabled: z.boolean(),

  /** If non-empty, only snipe launches from these deployer addresses. */
  deployerAllow: z.array(z.string()).max(500),
  /** Never snipe launches from these deployer addresses. */
  deployerDeny: z.array(z.string()).max(500),

  /** Safety caps. */
  maxConcurrentSnipes: z.number().int().min(1).max(50),
  maxSnipesPerHour: z.number().int().min(1).max(200),
  maxDailySpendEth: z.number().positive(),
});

export type SniperConfig = z.infer<typeof sniperConfigSchema>;

export const DEFAULT_CONFIG: SniperConfig = {
  enabled: false,
  ethAmount: "0.01",
  takeProfitPct: 60,
  stopLossPct: 30,
  trailingStopPct: null,
  graduationExitPct: 92,
  slippageBps: 800,
  // An observation window, not a tax dodge — see the note on the field.
  delaySeconds: 20,
  minLiquidityEth: 0.05,
  maxLiquidityEth: null,
  maxCreatorTaxBps: 300,
  minOtherBuys: 3,
  minBuyVelocity: null,
  // 20 dud launches is where the measured graduation rate collapses to 0.17%.
  maxDeployerDudLaunches: 20,
  // Off by default: it is a real but thin edge, and it silently rejects almost
  // everything, so it should be a deliberate choice rather than a surprise.
  minProvenBuyers: 0,
  watchWhenDisabled: true,
  nameAllowRegex: null,
  nameDenyRegex: null,
  deployerAllow: [],
  deployerDeny: [],
  maxConcurrentSnipes: 3,
  maxSnipesPerHour: 12,
  maxDailySpendEth: 0.1,
};

const FILE = join(dirname(env.databasePath), "sniper.json");

export function loadSniperConfig(): SniperConfig {
  try {
    if (existsSync(FILE)) {
      const parsed = sniperConfigSchema.safeParse(JSON.parse(readFileSync(FILE, "utf8")));
      if (parsed.success) return parsed.data;
    }
  } catch {
    /* fall through to defaults */
  }
  return { ...DEFAULT_CONFIG };
}

export function saveSniperConfig(cfg: SniperConfig): void {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
  } catch {
    /* exists */
  }
  writeFileSync(FILE, JSON.stringify(cfg, null, 2));
}
