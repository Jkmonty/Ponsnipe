import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256 } from "viem";
import { broadcast, RPCS } from "../src/app/browserTrade";

/** A signed transaction is just bytes to this code; the content is irrelevant. */
const RAW = "0xdeadbeef" as const;
const HASH = keccak256(RAW);

type Reply = { result?: string } | { error: { message: string } };

/** Stand in for every endpoint, answering per-URL. */
function stubFetch(byUrl: Record<string, Reply | "network-error">, seen?: string[]) {
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    seen?.push(u);
    const r = byUrl[u];
    if (r === "network-error") throw new Error("connection refused");
    return { json: async () => ({ jsonrpc: "2.0", id: 1, ...r }) } as Response;
  }) as typeof fetch;
}

const all = (r: Reply) => Object.fromEntries(RPCS.map((u) => [u, r]));

test("returns the hash the node reports", async () => {
  stubFetch(all({ result: HASH }));
  assert.equal(await broadcast(RAW), HASH);
});

test("goes to every endpoint, not just the first", async () => {
  const seen: string[] = [];
  stubFetch(all({ result: HASH }), seen);
  await broadcast(RAW);
  assert.deepEqual([...seen].sort(), [...RPCS].sort());
});

test("one endpoint accepting is enough", async () => {
  stubFetch({
    [RPCS[0]]: "network-error",
    [RPCS[1]]: { error: { message: "server overloaded" } },
    [RPCS[2]]: { result: HASH },
  });
  assert.equal(await broadcast(RAW), HASH);
});

test("'already known' is success, not failure", async () => {
  /*
   * The case this whole change could have broken. Sending one signed
   * transaction to three nodes means two of them are entitled to say they have
   * seen it — reporting that as an error would tell a trader their buy failed
   * while it was being mined, and invite them to buy again.
   */
  for (const msg of [
    "already known",
    "known transaction: 0xabc",
    "ALREADY EXISTS",
    "duplicate transaction",
  ]) {
    stubFetch(all({ error: { message: msg } }));
    assert.equal(await broadcast(RAW), HASH, msg);
  }
});

test("a duplicate on one node and success on another still returns the hash", async () => {
  stubFetch({
    [RPCS[0]]: { error: { message: "already known" } },
    [RPCS[1]]: { result: HASH },
    [RPCS[2]]: "network-error",
  });
  assert.equal(await broadcast(RAW), HASH);
});

test("a stale nonce is reported, not swallowed", async () => {
  // Ambiguous rather than reassuring: it can mean already mined, or that this
  // transaction will never land. Saying so beats claiming a buy that did not
  // happen.
  stubFetch(all({ error: { message: "nonce too low" } }));
  await assert.rejects(broadcast(RAW), /nonce too low/);
});

test("every endpoint failing surfaces a real reason", async () => {
  stubFetch(all({ error: { message: "insufficient funds for gas" } }));
  await assert.rejects(broadcast(RAW), /insufficient funds/);
});

test("a reply with neither result nor error is a failure", async () => {
  stubFetch(all({}));
  await assert.rejects(broadcast(RAW));
});
