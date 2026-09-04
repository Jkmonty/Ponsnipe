import type { SniperConfig } from "./config";
import type { TokenSnapshot } from "../pons/tokens";
import { reputationAvailable, deployerRecord, countProvenBuyers } from "./reputation";

export interface LaunchInfo {
  token: string;
  curve: string;
  deployer: string;
  pairToken: string;
  graduationThreshold: bigint;
}

export interface FilterInput {
  launch: LaunchInfo;
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
}

function safeRegex(src: string): RegExp | null {
  try {
    return new RegExp(src, "i");
  } catch {
    return null;
  }
}

/** Pure decision: should the sniper buy this launch? */
export function evaluateLaunch(input: FilterInput, cfg: SniperConfig): FilterResult {
  const { launch, snapshot, liquidityEth, otherBuys } = input;
  const dep = launch.deployer.toLowerCase();

  if (snapshot.venue !== "curve" || !snapshot.tradeable) {
    return { buy: false, reason: snapshot.reason ?? "not tradeable" };
  }
  if (!snapshot.quoteIsNative) {
    return { buy: false, reason: `pairs against ${snapshot.quoteSymbol}, not ETH` };
  }

  if (cfg.deployerDeny.map((a) => a.toLowerCase()).includes(dep)) {
    return { buy: false, reason: "deployer on denylist" };
  }
  if (cfg.deployerAllow.length > 0 && !cfg.deployerAllow.map((a) => a.toLowerCase()).includes(dep)) {
    return { buy: false, reason: "deployer not on allowlist" };
  }

  // Serial deployers who have never produced a graduate. The strongest negative
  // signal in the data: 0.17% vs a 1.91% baseline for a first-ever launch.
  // Silently skipped when no reputation database is present.
  if (cfg.maxDeployerDudLaunches != null && reputationAvailable()) {
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

  if (cfg.minLiquidityEth != null && liquidityEth < cfg.minLiquidityEth) {
    return { buy: false, reason: `liquidity ${liquidityEth.toFixed(3)} ETH < ${cfg.minLiquidityEth}` };
  }
  if (cfg.maxLiquidityEth != null && liquidityEth > cfg.maxLiquidityEth) {
    return { buy: false, reason: `liquidity ${liquidityEth.toFixed(3)} ETH > ${cfg.maxLiquidityEth}` };
  }

  if (otherBuys < cfg.minOtherBuys) {
    return { buy: false, reason: `only ${otherBuys} other buys (need ${cfg.minOtherBuys})` };
  }

  // The one filter that turned a losing book positive in testing.
  if (cfg.minProvenBuyers > 0) {
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

  if (cfg.minBuyVelocity != null) {
    const v = input.buyVelocity ?? 0;
    if (v < cfg.minBuyVelocity) {
      return {
        buy: false,
        reason: `buy velocity ${v.toFixed(2)}/s < ${cfg.minBuyVelocity}/s`,
      };
    }
  }

  const hay = `${snapshot.symbol} ${snapshot.name}`;
  if (cfg.nameAllowRegex) {
    const re = safeRegex(cfg.nameAllowRegex);
    if (re && !re.test(hay)) return { buy: false, reason: `name doesn't match /${cfg.nameAllowRegex}/i` };
  }
  if (cfg.nameDenyRegex) {
    const re = safeRegex(cfg.nameDenyRegex);
    if (re && re.test(hay)) return { buy: false, reason: `name matches denylist /${cfg.nameDenyRegex}/i` };
  }

  if (snapshot.graduation.progressPct >= 95) {
    return { buy: false, reason: "already ~graduating" };
  }

  return { buy: true, reason: "passed all filters" };
}
