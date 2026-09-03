import { test, before } from "node:test";
import assert from "node:assert/strict";

/**
 * Regression guard for the CSRF fix.
 *
 * These routes move real funds. Before the fix, any localhost request was
 * trusted with no token — so a page the user happened to be browsing could
 * POST to http://localhost:3000/api/... and arm live trading. A cross-origin
 * `fetch` with Content-Type text/plain is a "simple request" (no preflight),
 * and route handlers call req.json(), which parses regardless of Content-Type.
 * The attacker cannot read the response, but the trade still executes.
 */

process.env.ENGINE_API_TOKEN = "the-secret-token";

type Mod = typeof import("../src/lib/api");
let requireAuth: Mod["requireAuth"];

before(async () => {
  ({ requireAuth } = await import("../src/lib/api"));
});

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "POST", headers });
}
const LOCAL = "http://localhost:3000/api/positions";
const REMOTE = "http://10.0.0.5:3000/api/positions";

test("a plain same-origin call from our own page is allowed without a token", () => {
  assert.equal(
    requireAuth(req(LOCAL, { host: "localhost:3000", origin: "http://localhost:3000" })),
    null,
  );
});

test("a tool call with no Origin at all (curl, scripts) is allowed on loopback", () => {
  assert.equal(requireAuth(req(LOCAL, { host: "localhost:3000" })), null);
});

test("CSRF: a cross-origin Origin is refused even on loopback", async () => {
  const res = requireAuth(req(LOCAL, { host: "localhost:3000", origin: "https://evil.example" }));
  assert.ok(res, "must be refused");
  assert.equal(res!.status, 403);
});

test("CSRF: Sec-Fetch-Site cross-site is refused", () => {
  const res = requireAuth(
    req(LOCAL, { host: "localhost:3000", "sec-fetch-site": "cross-site" }),
  );
  assert.ok(res);
  assert.equal(res!.status, 403);
});

test("CSRF: Sec-Fetch-Site same-site (a sibling subdomain) is still refused", () => {
  const res = requireAuth(
    req(LOCAL, { host: "localhost:3000", "sec-fetch-site": "same-site" }),
  );
  assert.ok(res);
  assert.equal(res!.status, 403);
});

test("Sec-Fetch-Site none (typed into the address bar) is allowed", () => {
  assert.equal(
    requireAuth(req(LOCAL, { host: "localhost:3000", "sec-fetch-site": "none" })),
    null,
  );
});

test("a malformed Origin is refused rather than parsed loosely", () => {
  const res = requireAuth(req(LOCAL, { host: "localhost:3000", origin: "not a url" }));
  assert.ok(res);
  assert.equal(res!.status, 403);
});

test("an Origin on a different PORT is refused", () => {
  // Same host, different port is a different origin — and a different app.
  const res = requireAuth(
    req(LOCAL, { host: "localhost:3000", origin: "http://localhost:4000" }),
  );
  assert.ok(res);
  assert.equal(res!.status, 403);
});

test("HOST SPOOF: a remote caller must present the token, Host header notwithstanding", () => {
  // The Host header is attacker-controlled. It may only ever RELAX the token
  // requirement for genuine loopback use, never grant trust on its own.
  const noToken = requireAuth(req(REMOTE, { host: "10.0.0.5:3000" }));
  assert.ok(noToken, "a remote call without a token must be refused");
  assert.equal(noToken!.status, 401);

  const wrong = requireAuth(
    req(REMOTE, { host: "10.0.0.5:3000", "x-engine-token": "guess" }),
  );
  assert.equal(wrong!.status, 401);

  const right = requireAuth(
    req(REMOTE, { host: "10.0.0.5:3000", "x-engine-token": "the-secret-token" }),
  );
  assert.equal(right, null, "the correct token authorises a remote call");
});

test("a remote caller may use an Authorization: Bearer header", () => {
  assert.equal(
    requireAuth(
      req(REMOTE, { host: "10.0.0.5:3000", authorization: "Bearer the-secret-token" }),
    ),
    null,
  );
  assert.equal(
    requireAuth(
      req(REMOTE, { host: "10.0.0.5:3000", authorization: "Bearer nope" }),
    )!.status,
    401,
  );
});

test("127.0.0.1 counts as loopback, other private IPs do not", () => {
  assert.equal(requireAuth(req("http://127.0.0.1:3000/x", { host: "127.0.0.1:3000" })), null);
  const lan = requireAuth(req("http://192.168.1.9:3000/x", { host: "192.168.1.9:3000" }));
  assert.ok(lan, "a LAN address is not loopback and must need the token");
  assert.equal(lan!.status, 401);
});

test("cross-origin is rejected BEFORE the token is considered", () => {
  // Even a valid token must not rescue a cross-origin request — otherwise a
  // leaked token plus a malicious page is enough.
  const res = requireAuth(
    req(REMOTE, {
      host: "10.0.0.5:3000",
      origin: "https://evil.example",
      "x-engine-token": "the-secret-token",
    }),
  );
  assert.ok(res);
  assert.equal(res!.status, 403);
});
