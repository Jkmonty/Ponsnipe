/**
 * One-time setup: make sure .env exists and has strong secrets.
 * Safe to run repeatedly — it only fills blanks / placeholders.
 *
 *   npm run setup
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ENV = ".env";
const EXAMPLE = ".env.example";

const PLACEHOLDERS = [
  "",
  "change-me-to-a-long-random-string",
  "change-me-too",
  "change-me",
];

function secret(): string {
  return randomBytes(24).toString("base64url");
}

let text = existsSync(ENV)
  ? readFileSync(ENV, "utf8")
  : existsSync(EXAMPLE)
    ? readFileSync(EXAMPLE, "utf8")
    : "";

if (!text) {
  console.error("No .env or .env.example found — run this from the project root.");
  process.exit(1);
}

function ensure(key: string, value: () => string): boolean {
  const re = new RegExp(`^(${key}=)(.*)$`, "m");
  const m = text.match(re);
  if (m && !PLACEHOLDERS.includes(m[2].trim())) return false; // already set
  const line = `${key}=${value()}`;
  text = m ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
  return true;
}

const a = ensure("KEYSTORE_PASSPHRASE", secret);
const b = ensure("ENGINE_API_TOKEN", secret);

writeFileSync(ENV, text);

console.log(a || b ? "✓ Wrote secrets to .env" : "✓ .env already configured");
console.log("  KEYSTORE_PASSPHRASE  " + (a ? "generated" : "kept"));
console.log("  ENGINE_API_TOKEN     " + (b ? "generated" : "kept"));
console.log("\nNext:  npm run dev   →   open http://localhost:3000   →   click “Create wallet”");
