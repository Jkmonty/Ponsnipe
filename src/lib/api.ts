import { NextResponse } from "next/server";
import { env } from "./env";

/** JSON response that serialises bigint as decimal string. */
export function json(data: unknown, init?: ResponseInit): NextResponse {
  const body = JSON.stringify(data, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  return new NextResponse(body, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

export function errorJson(message: string, status = 400): NextResponse {
  return json({ error: message }, { status });
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Is the Host header pointing at loopback?
 *
 * NOTE: the Host header is attacker-controlled, so this can only ever RELAX a
 * convenience (skipping the token for solo local use) — never grant trust on
 * its own. Cross-origin requests are rejected before this is consulted, and the
 * dev server binds 127.0.0.1 (see the `dev` script), so a remote caller cannot
 * reach these routes at all in the default setup.
 */
function hostIsLoopback(req: Request): boolean {
  const h = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  return LOOPBACK.has(h);
}

/**
 * Reject anything that isn't a same-origin call from our own page.
 *
 * Without this, any website the user is browsing can POST to
 * http://localhost:3000/api/... . `fetch` with Content-Type text/plain is a
 * "simple request" (no preflight) and route handlers call req.json(), which
 * parses the body regardless of Content-Type — so a drive-by page could arm
 * live trading or open positions. The attacker cannot read the response, but
 * the trade would still execute.
 */
function crossOriginRejection(req: Request): NextResponse | null {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return errorJson("cross-origin request refused", 403);
  }

  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("host");
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return errorJson("bad Origin header", 403);
    }
    if (!host || originHost !== host) {
      return errorJson("cross-origin request refused", 403);
    }
  }
  return null;
}

/**
 * Guard state-changing routes.
 *  1. Must be same-origin (CSRF).
 *  2. Loopback Host  -> no token needed (solo local use).
 *     Anything else  -> must present ENGINE_API_TOKEN.
 */
export function requireAuth(req: Request): NextResponse | null {
  const cross = crossOriginRejection(req);
  if (cross) return cross;

  if (hostIsLoopback(req)) return null;

  if (!env.apiToken) {
    return errorJson(
      "This instance is reachable remotely but ENGINE_API_TOKEN is not set — refusing to trade.",
      500,
    );
  }
  const provided =
    req.headers.get("x-engine-token") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";
  if (provided !== env.apiToken) return errorJson("unauthorized", 401);
  return null;
}
