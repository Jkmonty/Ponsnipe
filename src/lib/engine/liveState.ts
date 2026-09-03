import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "../env";

/**
 * Live-trading switch. Backed by a small runtime file so it can be flipped from
 * the UI without editing .env or restarting. Falls back to ENGINE_LIVE.
 */
const FILE = join(dirname(env.databasePath), "engine.json");

export function isLive(): boolean {
  try {
    if (existsSync(FILE)) {
      const v = JSON.parse(readFileSync(FILE, "utf8")) as { live?: boolean };
      if (typeof v.live === "boolean") return v.live;
    }
  } catch {
    /* fall through */
  }
  return env.engineLive;
}

export function setLive(live: boolean): void {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
  } catch {
    /* exists */
  }
  writeFileSync(FILE, JSON.stringify({ live, updatedAt: new Date().toISOString() }, null, 2));
}
