/**
 * What distinguishes the coins a wallet snipes from the ones it ignores?
 *
 * The trap here is obvious and worth naming: list only what he bought and any
 * shared trait looks like a rule. A trait is only a signal if it is rarer among
 * the launches he passed over, so every number below is paired with a control
 * drawn from the same window.
 *
 *   npx tsx scripts/walletselection.ts [wallet] [windowBlocks]
 */
process.loadEnvFile?.(".env");
import { execFileSync } from "node:child_process";
import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import { robinhoodChain } from "../src/lib/chain";

const W = (process.argv[2] ?? "0x4f1daedbc131458af1d7515b597ab398dee57fab").toLowerCase() as Address;
const WINDOW = BigInt(process.argv[3] ?? "300000");
const XFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const c = createPublicClient({
  chain: robinhoodChain,
  transport: http(process.env.LOGS_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", {
    retryCount: 3,
    timeout: 40_000,
  }),
});

function gmgn(args: string[]): unknown {
  const out = execFileSync("gmgn-cli", args, {
    shell: process.platform === "win32",
    timeout: 90_000,
    maxBuffer: 32 * 1024 * 1024,
    encoding: "utf8",
  });
  return JSON.parse(out);
}

function extract(payload: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 6 || payload == null) return [];
  if (Array.isArray(payload)) {
    return payload.every((x) => x && typeof x === "object" && "address" in (x as object))
      ? (payload as Record<string, unknown>[])
      : [];
  }
  if (typeof payload !== "object") return [];
  for (const v of Object.values(payload as Record<string, unknown>)) {
    const hit = extract(v, depth + 1);
    if (hit.length) return hit;
  }
  return [];
}

const n = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const share = (xs: unknown[], f: (v: never) => boolean) =>
  xs.length ? (100 * (xs as never[]).filter(f).length) / xs.length : NaN;

async function main() {
  // 1. Everything he has bought recently.
  const head = await c.getBlockNumber();
  const bought = new Set<string>();
  for (let b = head - WINDOW; b <= head; b += 50_000n) {
    const hi = b + 49_999n > head ? head : b + 49_999n;
    const lg = await c.getLogs({ event: XFER, args: { to: W }, fromBlock: b, toBlock: hi }).catch(() => []);
    for (const l of lg) bought.add(String(l.address).toLowerCase());
  }

  // 2. The universe of recent launches, from GMGN. Anything he did not buy is
  //    the control -- same chain, same window, same launchpads.
  const universe = extract(
    gmgn(["market", "trenches", "--chain", "robinhood", "--type", "new_creation", "--limit", "80", "--raw"]),
  );

  const his = universe.filter((t) => bought.has(String(t.address).toLowerCase()));
  const not = universe.filter((t) => !bought.has(String(t.address).toLowerCase()));

  console.log(`wallet ${W}`);
  console.log(`bought ${bought.size} tokens in the last ${WINDOW} blocks`);
  console.log(`GMGN universe this pass: ${universe.length}  |  overlap with his buys: ${his.length}`);

  if (his.length < 5) {
    console.log(`\nOnly ${his.length} of his buys are in the current GMGN page, which is too few to`);
    console.log(`compare against a control. The page is a snapshot of the newest launches and he`);
    console.log(`trades faster than it refreshes, so run this repeatedly to accumulate overlap.`);
    console.log(`\nWhat his buys look like on their own (NOT yet evidence of a rule):`);
  }

  const rows: [string, (t: Record<string, unknown>) => number][] = [
    ["market cap $", (t) => n(t.market_cap)],
    ["liquidity $", (t) => n(t.liquidity)],
    ["24h volume $", (t) => n(t.volume_24h)],
    ["swaps 24h", (t) => n(t.swaps_24h)],
    ["holders", (t) => n(t.holder_count)],
    ["dev hold %", (t) => n(t.dev_team_hold_rate) * 100],
    ["top-10 hold %", (t) => n(t.top_10_holder_rate) * 100],
    ["sniper hold %", (t) => n(t.top70_sniper_hold_rate) * 100],
    ["insider hold %", (t) => n(t.suspected_insider_hold_rate) * 100],
    ["fresh wallet %", (t) => n(t.fresh_wallet_rate) * 100],
    ["bot degen %", (t) => n(t.bot_degen_rate) * 100],
    ["creator prior launches", (t) => n(t.creator_created_count)],
    ["renowned buyers", (t) => n(t.renowned_count)],
  ];

  console.log(`\n${"metric".padEnd(24)} ${"his buys".padStart(12)} ${"the rest".padStart(12)}`);
  console.log("-".repeat(52));
  for (const [label, get] of rows) {
    const a = median(his.map(get));
    const b = median(not.map(get));
    const fmt = (x: number) => (Number.isFinite(x) ? (Math.abs(x) >= 1000 ? x.toFixed(0) : x.toFixed(2)) : "-");
    console.log(`${label.padEnd(24)} ${fmt(a).padStart(12)} ${fmt(b).padStart(12)}`);
  }

  const pads = (xs: Record<string, unknown>[]) => {
    const m = new Map<string, number>();
    for (const t of xs) {
      const k = String(t.launchpad ?? t.launchpad_platform ?? "?");
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((x, y) => y[1] - x[1]);
  };
  console.log(`\nlaunchpad mix`);
  console.log(`  his buys : ${pads(his).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}`);
  console.log(`  the rest : ${pads(not).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}`);
  console.log(`\nhoneypot-flagged`);
  console.log(`  his buys : ${share(his, (t) => (t as Record<string, unknown>).is_honeypot === "yes").toFixed(0)}%`);
  console.log(`  the rest : ${share(not, (t) => (t as Record<string, unknown>).is_honeypot === "yes").toFixed(0)}%`);
}

main().catch((e) => console.log("ERR", String(e).slice(0, 250)));
