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
   *
   * It does NOT reject almost everything, which this note used to claim and
   * which was the stated reason it ships off. Measured against 3,660 live
   * curves at the +20s decision point, using only wallets that had bought by
   * then: 27.7% had four or more proven buyers, and 328 of 1,573 ETH-quoted
   * curves passed — around a fifth of everything this sniper can actually buy.
   * So the cost of turning it on is roughly a 4-in-5 cut in candidates, not the
   * near-total silence the old wording implied.
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

  /**
   * Tickers to buy on sight.
   *
   * For the case where you already know a coin is coming and what it will be
   * called. A match bypasses the crowd-quality filters — the observation
   * window, the other-buyer minimum, buy velocity, proven buyers and the
   * deployer dud-record check — because those exist to judge a launch you know
   * nothing about, and here you claim to know something. What it does NOT
   * bypass: tradeability, the creator-tax cap, the deployer denylist, and
   * every spend cap. Those are traps and budgets, not opinions.
   *
   * `deployer` is the part that makes this safe, and it is worth being blunt
   * about why. Anyone can deploy a token with any ticker, and they do: in a
   * single three-hour window of indexed launches, 27% of tickers had already
   * been used more than once, VLAD appeared 65 times from 51 different makers
   * and TRUMP 19 times from 18. A ticker-only watch will therefore almost
   * certainly fire on a squatter minutes before the launch you meant. Pinning
   * the deployer address turns "any coin called X" into "the coin called X
   * from the person I am waiting for".
   */
  tickerWatch: z
    .array(
      z.object({
        /** Matched against the token symbol, case-insensitively, exactly. */
        ticker: z.string().trim().min(1).max(32),
        /** Only this deployer counts. null means any, which is the risky mode. */
        deployer: z.string().nullable(),
        /** Overrides ethAmount for this watch. null uses the global amount. */
        ethAmount: z.string().nullable(),
        /** Stop after this many matching buys. */
        maxBuys: z.number().int().min(1).max(10),
        /** How many it has bought. Persisted so a restart cannot re-arm it. */
        bought: z.number().int().min(0),
        /** ISO timestamp after which this watch is ignored. null never expires. */
        expiresAt: z.string().nullable(),
      }),
    )
    .max(20)
    /*
     * Defaulted, not required.
     *
     * loadSniperConfig falls back to DEFAULT_CONFIG when the saved file fails
     * to parse, so adding a REQUIRED field here would make every existing
     * sniper.json invalid and silently reset somebody's tuned filters to
     * stock. Any new field added below must default for the same reason.
     */
    .default([]),

  /**
   * Delay before buying a ticker match, in seconds.
   *
   * Separate from delaySeconds, which is 20s because waiting is how the sniper
   * observes whether anyone else bought. A ticker watch is not observing — you
   * already decided — so waiting only costs price.
   */
  tickerDelaySeconds: z.number().int().min(0).max(120).default(4),

  /**
   * Buy launches quoted in something other than ETH, by swapping first.
   *
   * About half of all launches are quoted in USDG, NVDA or another tokenised
   * equity, and without this every one is refused with "pairs against X, not
   * ETH" — measured at 128 of 250 live rows. Turning it on routes ETH through
   * the deepest Uniswap V3 pool for that asset before buying the curve.
   *
   * Off by default because it is not free: the swap costs its own pool fee
   * (5bps on the deep tiers), a second transaction's gas, and a second chance
   * to be reverted, all inside the seconds that decide a snipe. Worth it to
   * double the reachable market, but it should be a decision rather than a
   * surprise on someone's gas bill.
   */
  allowNonEthQuotes: z.boolean().default(false),

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
  // Off by default because it is a real but thin edge whose confidence
  // interval touched zero — a deliberate choice, not a surprise. Not because
  // it rejects everything: measured, it passes about a fifth of ETH-quoted
  // launches. See the note on the field.
  minProvenBuyers: 0,
  watchWhenDisabled: true,
  nameAllowRegex: null,
  nameDenyRegex: null,
  deployerAllow: [],
  deployerDeny: [],
  tickerWatch: [],
  allowNonEthQuotes: false,
  // Fast, but not zero: pons taxes the first ~3 seconds after a launch at up
  // to 99%, so buying instantly hands most of the position to the tax.
  tickerDelaySeconds: 4,
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
