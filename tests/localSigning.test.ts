import { test } from "node:test";
import assert from "node:assert/strict";
import { createWalletClient, custom, parseEther } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { robinhoodChain } from "../src/lib/chain";

/**
 * The wallet must sign in the browser and send raw bytes.
 *
 * Passing a bare address instead of the account makes viem treat it as a
 * JSON-RPC account — one the node is expected to hold the key for — so it
 * calls eth_sendTransaction and a public endpoint answers "the method does not
 * exist". That is what every buy did, and it is invisible until money moves.
 */
function recordingTransport(seen: string[]) {
  return custom({
    async request({ method }: { method: string; params?: unknown }) {
      seen.push(method);
      switch (method) {
        case "eth_chainId":
          return `0x${robinhoodChain.id.toString(16)}`;
        case "eth_getTransactionCount":
          return "0x0";
        case "eth_gasPrice":
        case "eth_maxPriorityFeePerGas":
          return "0x3b9aca00";
        case "eth_estimateGas":
          return "0x5208";
        case "eth_getBlockByNumber":
          return { baseFeePerGas: "0x3b9aca00", number: "0x1", timestamp: "0x1" };
        case "eth_sendRawTransaction":
          return `0x${"11".repeat(32)}`;
        case "eth_sendTransaction":
          throw new Error('The method "eth_sendTransaction" does not exist / is not available.');
        default:
          return null;
      }
    },
  });
}

test("a local account signs and sends raw, never eth_sendTransaction", async () => {
  const seen: string[] = [];
  const account = privateKeyToAccount(generatePrivateKey());
  const client = createWalletClient({
    account,
    chain: robinhoodChain,
    transport: recordingTransport(seen),
  });

  await client.sendTransaction({
    account,
    chain: robinhoodChain,
    to: "0x0000000000000000000000000000000000000001",
    value: parseEther("0.001"),
  });

  assert.ok(seen.includes("eth_sendRawTransaction"), `signed locally; saw ${seen.join(", ")}`);
  assert.ok(!seen.includes("eth_sendTransaction"), "must never ask the node to sign");
});

test("a bare address takes the path that failed, which is why the type is Account", async () => {
  // Kept as the counter-example: this is exactly what executeBuy used to do,
  // and it reproduces the error a trader saw instead of a buy.
  const seen: string[] = [];
  const client = createWalletClient({ chain: robinhoodChain, transport: recordingTransport(seen) });
  await assert.rejects(
    client.sendTransaction({
      account: "0x0000000000000000000000000000000000000002",
      chain: robinhoodChain,
      to: "0x0000000000000000000000000000000000000001",
      value: parseEther("0.001"),
    }),
    /eth_sendTransaction/,
  );
});
