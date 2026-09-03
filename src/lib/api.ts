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

function isLocalRequest(req: Request): boolean {
  try {
    const host = new URL(req.url).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") {
      return true;
    }
    // Behind `next dev` the URL host can be an IP; check the Host header too.
    const h = (req.headers.get("host") ?? "").split(":")[0];
    return h === "localhost" || h === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * Guard state-changing routes.
 * - Local (localhost) requests are trusted — no token needed for solo use.
 * - Remote requests must present ENGINE_API_TOKEN (required once deployed).
 */
export function requireAuth(req: Request): NextResponse | null {
  if (isLocalRequest(req)) return null;

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
