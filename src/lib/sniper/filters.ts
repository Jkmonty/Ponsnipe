import type { SniperConfig } from "./config";
import type { TokenSnapshot } from "../pons/tokens";
import { reputationAvailable, deployerRecord, countProvenBuyers } from "./reputation";

/**
 * A tickerWatch entry that matched this launch, decided before the delay.
 * Present means "you asked for this one by name"; absent is the normal path.
 */
export interface TickerHit {
  ticker: string;
  pinnedDeployer: boolean;
  ethAmount: string | null;
}

export interface LaunchInfo {
  token: string;
  curve: string;
  deployer: string;
  pairToken: string;
  graduationThreshold: bigint;
}

export interface FilterInput {
  launch: LaunchInfo;
  /** Set when a tickerWatch entry named this launch. */
  tickerHit?: TickerHit | null;
  snapshot: TokenSnapshot;
  /** Real ETH in the curve right now. */
  liquidityEth: number;
  /** Count of buys by wallets other than the deployer during the delay window. */
  otherBuys: number;
  /** Buys per second across the delay window — momentum, not just a count. */
  buyVelocity?: number;
  /**
   * The non-deployer wallets that bought during the delay window. Needed by the
   * proven-buyer filter, which cares who bought rather than how many.
   */
  buyers?: string[];
}

export interface FilterResult {
  buy: boolean;
  reason: string;
  /**
   * True when the ONLY thing standing between us and this launch is that it is
   * quoted in a stock or stablecoin token rather than ETH. Those are most of
   * the venue and we cannot reach them until the zap exists, so the feed marks
   * them separately from launches that genuinely failed the filters.
   */
  blockedByQuote?: boolean;
}

/** Options for evaluation, used to answer "would we have taken it otherwise?". */
export interface FilterOptions {
  /** Skip the ETH-quote requirement, to test the rest of the rules against it. */
  ignoreQuote?: boolean;
}

function safeRegex(src: string): RegExp | null {
  try {
    return new RegExp(src, "i");
  } catch {
    return null;
  }
}

/** Pure decision: should the sniper buy this launch? */
export function evaluateLaunch(
  input: FilterInput,
  cfg: SniperConfig,
  opts: FilterOptions = {},
): FilterResult {
  const { launch, snapshot, liquidityEth, otherBuys } = input;
  const dep = launch.deployer.toLowerCase();

  if (snapshot.venue !== "curve" || !snapshot.tradeable) {
    return { buy: false, reason: snapshot.reason ?? "not tradeable" };
  }
  if (!snapshot.quoteIsNative && !opts.ignoreQuote) {
    // Re-run everything else to find out whether the quote token is the ONLY
    // obstacle. That distinction is the difference between "we rejected this"
    // and "we are simply unable to reach it yet".
    const rest = evaluateLaunch(input, cfg, { ignoreQuote: true });
    return {
      buy: false,
      reason: `pairs against ${snapshot.quoteSymbol}, not ETH`,
      blockedByQuote: rest.buy,
    };
  }

  if (cfg.deployerDeny.map((a) => a.toLowerCase()).includes(dep)) {
    return { buy: false, reason: "deployer on denylist" };
  }
  if (cfg.deployerAllow.length > 0 && !cfg.deployerAllow.map((a) => a.toLowerCase()).includes(dep)) {
    return { buy: false, reason: "deployer not on allowlist" };
  }

  /*
   * A named ticker skips the judgement filters, not the safety ones.
   *
   * Everything above this point stays: tradeable, ETH-quoted, denylist. So do
   * the creator-tax cap below and every spend cap in the engine. What it skips
   * is the block of filters that exist to form an opinion about a launch
   * nobody asked for — the deployer's record, the other-buyer minimum, buy
   * velocity, proven buyers, and the name regexes. You named it; that is the
   * opinion.
   */
  const named = !!input.tickerHit;

  // Serial deployers who have never produced a graduate. The strongest negative
  // signal in the data: 0.17% vs a 1.91% baseline for a first-ever launch.
  // Silently skipped when no reputation database is present.
  if (!named && cfg.maxDeployerDudLaunches != null && reputationAvailable()) {
    const rec = deployerRecord(dep);
    if (rec.graduated === 0 && rec.launches >= cfg.maxDeployerDudLaunches) {
      return {
        buy: false,
        reason: `deployer has ${rec.launches} prior launches, none graduated`,
      };
    }
  }

  if (snapshot.creatorTaxBps > cfg.maxCreatorTaxBps) {
    return {
      buy: false,
      reason: `creator tax ${(snapshot.creatorTaxBps / 100).toFixed(1)}% > ${(cfg.maxCreatorTaxBps / 100).toFixed(1)}%`,
    };
  }

  if (!named && cfg.minLiquidityEth != null && liquidityEth < cfg.minLiquidityEth) {
    return { buy: false, reason: `liquidity ${liquidityEth.toFixed(3)} ETH < ${cfg.minLiquidityEth}` };
  }
  if (!named && cfg.maxLiquidityEth != null && liquidityEth > cfg.maxLiquidityEth) {
    return { buy: false, reason: `liquidity ${liquidityEth.toFixed(3)} ETH > ${cfg.maxLiquidityEth}` };
  }

  if (!named && otherBuys < cfg.minOtherBuys) {
    return { buy: false, reason: `only ${otherBuys} other buys (need ${cfg.minOtherBuys})` };
  }

  // The one filter that turned a losing book positive in testing.
  if (!named && cfg.minProvenBuyers > 0) {
    if (!reputationAvailable()) {
      return { buy: false, reason: "minProvenBuyers set but no reputation database — run `npm run reputation`" };
    }
    const proven = countProvenBuyers(input.buyers ?? []);
    if (proven < cfg.minProvenBuyers) {
      return {
        buy: false,
        reason: `${proven} proven buyers (need ${cfg.minProvenBuyers})`,
      };
    }
  }

  if (!named && cfg.minBuyVelocity != null) {
    const v = input.buyVelocity ?? 0;
    if (v < cfg.minBuyVelocity) {
      return {
        buy: false,
        reason: `buy velocity ${v.toFixed(2)}/s < ${cfg.minBuyVelocity}/s`,
      };
    }
  }

  const hay = `${snapshot.symbol} ${snapshot.name}`;
  if (!named && cfg.nameAllowRegex) {
    const re = safeRegex(cfg.nameAllowRegex);
    if (re && !re.test(hay)) return { buy: false, reason: `name doesn't match /${cfg.nameAllowRegex}/i` };
  }
  if (!named && cfg.nameDenyRegex) {
    const re = safeRegex(cfg.nameDenyRegex);
    if (re && re.test(hay)) return { buy: false, reason: `name matches denylist /${cfg.nameDenyRegex}/i` };
  }

  if (snapshot.graduation.progressPct >= 95) {
    return { buy: false, reason: "already ~graduating" };
  }

  return { buy: true, reason: "passed all filters" };
}
