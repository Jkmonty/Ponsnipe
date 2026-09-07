import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The trading engine (monitor loop, keystore, node:sqlite) must run in the
  // Node.js runtime, never Edge. src/instrumentation.ts boots the monitor loop
  // on server start (stable in Next 15, runs in `next dev` and `next start`).
  serverExternalPackages: ["better-sqlite3"],

  /*
   * Bundle a self-contained server into .next/standalone.
   *
   * Only used for the container build: it lets the runtime image ship the
   * traced server and its dependencies instead of the whole node_modules
   * tree, which is the difference between an image of a few hundred megabytes
   * and one well over a gigabyte. `npm run dev` and `npm start` are unaffected.
   */
  output: "standalone",

  /*
   * Note what standalone output does NOT do.
   *
   * `npm run build` copies .env and the whole data/ directory — the keystore
   * and every database, 1.8GB here — into .next/standalone. That is not the
   * file tracer, so outputFileTracingExcludes does not stop it; it was tried
   * with both "./data/**" and "data/**" and neither had any effect.
   *
   * The container build is safe because .dockerignore keeps those paths out of
   * the build context entirely, so `COPY . .` cannot pick up what Docker
   * never received. Locally, treat .next as containing secrets: it is
   * gitignored, but do not zip it, upload it, or copy it to another machine.
   */

  /*
   * Security headers.
   *
   * These matter more here than on a normal site: a trading key lives in the
   * visitor's browser, so any script that runs on this page can spend it. A
   * CSP does not stop a hostile deploy — nothing client-side can — but it is
   * what stands between an injected third-party script and the key.
   *
   * connect-src is the important line. Exfiltration needs somewhere to send
   * to, and this limits that to this origin and the chain endpoints the app
   * actually uses.
   *
   * Known gap, stated rather than hidden: img-src has to allow arbitrary https
   * because token artwork falls back to loading the contract's own URL
   * directly when the proxy cannot fetch it. An image URL can carry data in
   * its query string, so that path remains an exfiltration channel. Closing it
   * means dropping the direct fallback and serving every logo through
   * /api/img.
   *
   * Applied in production only: `next dev` needs eval and inline websockets
   * for hot reload, and a CSP that has to be loosened for development is a CSP
   * nobody trusts in production.
   */
  async headers() {
    if (process.env.NODE_ENV !== "production") return [];
    const csp = [
      "default-src 'self'",
      // Next inlines its bootstrap; without nonce plumbing this is required.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://robinhood-rpc.publicnode.com https://rpc.mainnet.chain.robinhood.com https://rpc.ordofi.network https://api.coinbase.com https://query1.finance.yahoo.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests",
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          // No reason for this page to reach a camera, a microphone or a
          // location, and saying so cheaply removes a class of abuse.
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
