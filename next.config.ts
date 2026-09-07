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
};

export default nextConfig;
