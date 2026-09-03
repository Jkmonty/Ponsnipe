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
   * Seconds to wait after a launch before buying. pons charges up to ~99%
   * anti-snipe tax that decays over ~15s, so buying at block 0 is a trap.
   * Default sits comfortably past that window.
   */
  delaySeconds: z.number().int().min(0).max(600),

  /** Curve's real ETH reserve at buy time must be within this band. null = no bound. */
  minLiquidityEth: z.number().nonnegative().nullable(),
  maxLiquidityEth: z.number().positive().nullable(),

  /** Reject launches whose permanent creator tax exceeds this (bps). */
  maxCreatorTaxBps: z.number().int().min(0).max(2000),

  /** Require at least this many *other* buys on the curve during the delay window. */
  minOtherBuys: z.number().int().min(0).max(1000),

  /** Symbol/name must match this (case-insensitive regex). null = any. */
  nameAllowRegex: z.string().nullable(),
  /** Symbol/name must NOT match this. null = no filter. */
  nameDenyRegex: z.string().nullable(),

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
  delaySeconds: 20,
  minLiquidityEth: 0.05,
  maxLiquidityEth: null,
  maxCreatorTaxBps: 300,
  minOtherBuys: 3,
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
