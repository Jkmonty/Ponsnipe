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
   * img-src is same-origin: the direct-URL image fallback was removed so this
   * page never GETs an arbitrary host, since an image URL can carry a secret
   * in its query string. /api/img itself only serves logos the app has
   * indexed, which closes the same channel by its other door — a same-origin
   * request that a CSP is obliged to allow.
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
      // Same-origin only. Every logo goes through /api/img, so the page has no
      // reason to GET an arbitrary host — and an image URL is otherwise a way
      // to carry a secret off a page that holds an unlocked key.
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https://robinhood-rpc.publicnode.com https://rpc.mainnet.chain.robinhood.com https://rpc.ordofi.network https://api.coinbase.com https://query1.finance.yahoo.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      /*
       * upgrade-insecure-requests is NOT here, and that is deliberate.
       *
       * It rewrites every request on the page to https://, which is correct
       * behind TLS and fatal without it. On a server reached by IP — no
       * domain, so no certificate — it upgraded every stylesheet, script and
       * image to an https:// URL that nothing was listening on, and the site
       * rendered as raw unstyled HTML with no JavaScript at all. The server
       * was serving every asset perfectly; the browser was throwing them away
       * before asking.
       *
       * Little is lost. Caddy redirects http to https as soon as a domain is
       * configured, every URL in this app is relative and so inherits whatever
       * scheme the page was loaded over, and default-src 'self' already bars
       * third-party content. The directive only ever added protection this
       * CSP was providing anyway.
       */
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
