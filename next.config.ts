import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The trading engine (monitor loop, keystore, node:sqlite) must run in the
  // Node.js runtime, never Edge. src/instrumentation.ts boots the monitor loop
  // on server start (stable in Next 15, runs in `next dev` and `next start`).
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
