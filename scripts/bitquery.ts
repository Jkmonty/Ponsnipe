/**
 * Check the Bitquery launch stream, and measure whether it beats the sweep.
 *
 * Connects, waits for launches, and reports how long each took to arrive after
 * its block was produced. That number is the entire case for paying for this:
 * the polling sweep already captures 99.9% of launches, so the only thing on
 * offer is getting them sooner.
 *
 *   npm run bitquery [seconds]
 */
process.loadEnvFile?.(".env");
import { createPublicClient, http } from "viem";
import { robinhoodChain } from "../src/lib/chain";
import { PONS } from "../src/lib/pons/addresses";

const SECONDS = Number(process.argv[2] ?? 90);
const TOKEN = process.env.BITQUERY_TOKEN?.trim() ?? "";

const SUBSCRIPTION = `
subscription {
  EVM(network: robinhood) {
    Events(
      where: {
        LogHeader: { Address: { is: "${PONS.factory.toLowerCase()}" } }
        Log: { Signature: { Name: { is: "TokenLaunched" } } }
      }
    ) {
      Block { Number Time }
      Transaction { Hash }
      Arguments {
        Name
        Value {
          ... on EVM_ABI_Address_Value_Arg { address }
          ... on EVM_ABI_BigInt_Value_Arg { bigInteger }
        }
      }
    }
  }
}`;

async function main() {
  if (!TOKEN) {
    console.log("BITQUERY_TOKEN is not set in .env.");
    console.log("Get one at https://account.bitquery.io/user/api_v2/access_tokens");
    console.log("then add:  BITQUERY_TOKEN=your_token");
    process.exit(1);
  }

  const rpc = createPublicClient({
    chain: robinhoodChain,
    transport: http("https://rpc.mainnet.chain.robinhood.com", { retryCount: 2, timeout: 20_000 }),
  });

  console.log(`connecting… (listening ${SECONDS}s)`);
  const ws = new WebSocket(
    `wss://streaming.bitquery.io/graphql?token=${encodeURIComponent(TOKEN)}`,
    "graphql-transport-ws",
  );

  let acked = false;
  let events = 0;
  const lags: number[] = [];

  ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "connection_init", payload: {} })));

  ws.addEventListener("message", async (e) => {
    let m: { type?: string; payload?: unknown };
    try {
      m = JSON.parse(String((e as MessageEvent).data));
    } catch {
      return;
    }

    if (m.type === "connection_ack") {
      acked = true;
      console.log("authenticated, subscribing…");
      ws.send(JSON.stringify({ id: "t", type: "subscribe", payload: { query: SUBSCRIPTION } }));
      return;
    }
    if (m.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
    if (m.type === "error") {
      console.log("ERROR:", JSON.stringify(m.payload).slice(0, 300));
      return;
    }
    if (m.type !== "next") return;

    const evs =
      (m.payload as { data?: { EVM?: { Events?: Record<string, unknown>[] } } })?.data?.EVM?.Events ?? [];
    for (const ev of evs) {
      events++;
      const args = (ev.Arguments as { Name?: string; Value?: { address?: string } }[]) ?? [];
      const sym = args.find((a) => a.Name === "token")?.Value?.address ?? "?";
      const blockTime = (ev.Block as { Time?: string })?.Time;
      // Lag measured against the block's own timestamp, so it is the delay
      // from the launch existing on chain to it reaching us.
      const lag = blockTime ? (Date.now() - Date.parse(blockTime)) / 1000 : NaN;
      if (Number.isFinite(lag)) lags.push(lag);
      console.log(`  launch ${String(sym).slice(0, 12)}  block ${(ev.Block as { Number?: string })?.Number}  +${lag.toFixed(1)}s`);
    }
  });

  ws.addEventListener("close", (e) => {
    if (!acked) console.log(`closed before auth (code ${(e as CloseEvent).code}) — check the token`);
  });

  const head = await rpc.getBlockNumber().catch(() => 0n);
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  const head2 = await rpc.getBlockNumber().catch(() => 0n);
  try {
    ws.close();
  } catch {
    /* ignore */
  }

  lags.sort((a, b) => a - b);
  console.log(`\n  authenticated : ${acked}`);
  console.log(`  launches seen : ${events} in ${SECONDS}s`);
  if (lags.length) {
    console.log(`  lag behind the block: median ${lags[Math.floor(lags.length / 2)].toFixed(1)}s  best ${lags[0].toFixed(1)}s`);
    console.log(`  (our polling sweep measured ~1.7s launch-to-visible)`);
  }
  console.log(`  chain advanced ${head2 - head} blocks meanwhile`);
  process.exit(0);
}

main().catch((e) => {
  console.log("ERR", String(e).slice(0, 200));
  process.exit(1);
});
