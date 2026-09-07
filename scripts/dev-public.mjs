/**
 * The visitor's view of the app, on purpose.
 *
 * PUBLIC_MODE hides the sniper, the positions table, the launch composer and
 * the live switch — everything that needs the bot wallet. That is right for a
 * hosted instance and alarming on your own machine, where it looks like half
 * the app has been deleted. It happened: a dev server left running with the
 * variable set made the sniper vanish with nothing on screen to say why.
 *
 * So the public view gets its own command rather than an environment variable
 * you set once and forget, `npm run dev` always gives you the whole app, and
 * the header says PUBLIC VIEW when you are looking at the cut-down one.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

/*
 * Resolved through Node rather than left to PATH. `next` is only on PATH
 * inside an npm script, so spawning it by name works from `npm run` and fails
 * with "not recognized" the moment anything else runs this file.
 */
const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

// Extra arguments pass straight through: `npm run dev:public -- -p 3001`.
// Note that Next 16 refuses a second dev server from the same directory, so
// this switches views rather than running both at once — stop `npm run dev`
// first.
spawn(process.execPath, [nextBin, "dev", "-H", "127.0.0.1", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, PUBLIC_MODE: "1" },
}).on("exit", (code) => process.exit(code ?? 0));
