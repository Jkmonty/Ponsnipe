# Front Door Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A landing page at `/` for the hosted instance, built around the paper sniper and the Sherwood range, with the terminal moved to `/terminal` and otherwise untouched.

**Architecture:** Two nested route groups under the existing root layout: `(site)` carries its own layout, fonts and stylesheet for the landing, the range and the paper sniper; `(terminal)` holds the dashboard at `/terminal`. Two small library modules are lifted out of route handlers so server components can call them directly. The design tokens in `globals.css` stay the base; a new `site.css` adds the Sherwood layer under a `.site` wrapper class so nothing reaches the terminal.

**Tech Stack:** Next.js 16 App Router (Turbopack dev), React 19, TypeScript strict, viem, `node:sqlite` via `src/lib/db`, `next/font/google`, plain CSS. Tests run with `node --import tsx --test`.

**Spec:** `docs/superpowers/specs/2026-09-13-front-door-design.md`

## Global Constraints

- Node `>=22.5.0`. Next `^16.3.4`. Do not add dependencies.
- **This is not the Next.js you know.** Before writing any Next code, read the relevant guide under `node_modules/next/dist/docs/01-app/` (route groups: `03-api-reference/03-file-conventions/route-groups.md`; fonts: `01-getting-started/13-fonts.md`; redirect: `03-api-reference/04-functions/redirect.md`; config redirects: `03-api-reference/05-config/01-next-config-js/redirects.md`).
- The terminal (`src/app/Dashboard.tsx` and every file it imports, and every rule in `src/app/globals.css`) is not modified, except the one change in Task 1 that makes the mark a link to `/`.
- Production CSP allows `font-src 'self' data:`. Fonts load only through `next/font`, never a `<link>` to Google.
- Colour carries meaning: lime = "you can act on this", gold = brand and the pool, green/red = money and day moves, nothing else.
- Copy never implies a return. Every number on the page comes from `README.md`, `docs/ROADMAP.md` or `docs/FINDINGS.md`.
- Commit messages follow the repo's style: a short plain sentence saying what changed and why, then the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- To see the landing page locally, run the dev server with `PUBLIC_MODE=1` (PowerShell: `$env:PUBLIC_MODE='1'; npm run dev`). Without it, `/` redirects to `/terminal` by design.
- Imports use the `@/` alias (`@/lib/...`, `@/app/...`), which maps to `src/`.

---

## File map

| Path | Responsibility |
|---|---|
| `src/app/(terminal)/terminal/page.tsx` | The dashboard at `/terminal` (the old root page, moved) |
| `src/app/(site)/layout.tsx` | Site shell: fonts as CSS variables, nav, footer, `site.css` |
| `src/app/(site)/site.css` | The Sherwood layer, every rule scoped under `.site` |
| `src/app/(site)/SiteNav.tsx` | Mark, wordmark, links, Terminal button |
| `src/app/(site)/SiteFooter.tsx` | X, source, fee wallet, run your own |
| `src/app/(site)/page.tsx` | The landing page at `/`; redirects locally |
| `src/app/(site)/Butt.tsx` | The archery target, drawn once, used three times |
| `src/app/(site)/Hero.tsx` | Copy, buttons, pool line, butt with pins, board card |
| `src/app/(site)/BoardCard.tsx` | Top three, week end, pool |
| `src/app/(site)/PaperSniper.tsx` | The game, lifted from `play/page.tsx` |
| `src/app/(site)/RangeWindow.tsx` | CSS scene with "Enter the range" |
| `src/app/(site)/TerminalStrip.tsx` | Five newest launches |
| `src/app/(site)/HonestNumbers.tsx` | Three figures from the findings |
| `src/app/(site)/play/page.tsx` | `/play`: site shell around `PaperSniper` |
| `src/app/(site)/range/page.tsx` | `/range`: the arcade page, moved and reskinned |
| `src/app/(site)/range/{world,sfx,kit}.ts` | Moved unchanged |
| `src/app/(site)/range/sounds/page.tsx` | Moved; one import path updated |
| `src/lib/targets.ts` | Quote + cache, lifted from the targets route; `pickPins` |
| `src/lib/pool.ts` | Fee wallet address, balance read, formatting |
| `tests/targets.test.ts`, `tests/pool.test.ts` | Pure-function tests |
| `next.config.ts` | Permanent redirects from `/arcade*` |

---

### Task 1: Move the terminal to `/terminal` and put a redirecting placeholder at `/`

**Files:**
- Create: `src/app/(terminal)/terminal/page.tsx`
- Create: `src/app/(site)/page.tsx` (placeholder for now)
- Delete: `src/app/page.tsx`
- Modify: `src/app/Dashboard.tsx:231-241` (the lockup becomes a link)

**Interfaces:**
- Produces: route `/terminal` rendering `Dashboard` inside `WalletProvider`; route `/` that calls `redirect("/terminal")` when `env.publicMode` is false.

- [ ] **Step 1: Read the route-group and redirect docs**

Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route-groups.md` and `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/redirect.md`. Note: `redirect` throws, so it is never called inside `try`.

- [ ] **Step 2: Create the terminal page**

Create `src/app/(terminal)/terminal/page.tsx` with the exact content of the current `src/app/page.tsx`, import paths adjusted for the deeper folder:

```tsx
import Dashboard from "@/app/Dashboard";
import { WalletProvider } from "@/app/WalletContext";

export const dynamic = "force-dynamic";

export default function TerminalPage() {
  /*
   * The wallet sits above the dashboard rather than inside the trade panel,
   * because two things need it now: the connect button in the header and the
   * buy form in the sidebar. One provider means one balance and one lock
   * timer, so the header cannot say unlocked while the panel says otherwise.
   */
  return (
    <WalletProvider>
      <Dashboard />
    </WalletProvider>
  );
}
```

- [ ] **Step 3: Create the placeholder landing page**

Create `src/app/(site)/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * The front door.
 *
 * Only a hosted instance has strangers. On a local install the root goes
 * straight to the tool, so `npm run dev` still opens the terminal.
 */
export default function Landing() {
  if (!env.publicMode) redirect("/terminal");
  return (
    <main>
      <h1>Ponsnipe</h1>
    </main>
  );
}
```

- [ ] **Step 4: Delete the old root page**

```bash
git rm src/app/page.tsx
```

- [ ] **Step 5: Make the terminal's mark a link home**

In `src/app/Dashboard.tsx`, the lockup block (around lines 231-241) currently reads:

```tsx
          <div className="lockup">
            <Logo size={34} />
            <img
              className="wordmark"
              src="/brand/wordmark.webp"
              srcSet="/brand/wordmark.webp 1x, /brand/wordmark@2x.webp 2x"
              alt="Ponsnipe"
              decoding="async"
            />
            <h1 className="sr-only">Ponsnipe</h1>
          </div>
```

Change the wrapper to an anchor with the same class, so no CSS changes:

```tsx
          <a className="lockup" href="/" title="Front door">
            <Logo size={34} />
            <img
              className="wordmark"
              src="/brand/wordmark.webp"
              srcSet="/brand/wordmark.webp 1x, /brand/wordmark@2x.webp 2x"
              alt="Ponsnipe"
              decoding="async"
            />
            <h1 className="sr-only">Ponsnipe</h1>
          </a>
```

A plain `<a>` rather than `Link`, because on a local install `/` redirects straight back and a client-side navigation to a redirect is not worth the import. Add `text-decoration: none;` is not needed: `.lockup` contains only images and a visually hidden heading.

- [ ] **Step 6: Typecheck and run the tests**

Run: `npm run typecheck && npm test`
Expected: no type errors; all existing tests pass.

- [ ] **Step 7: Verify both routes in the browser**

Start the dev server (default env, no `PUBLIC_MODE`). Open `/`: expect a redirect to `/terminal` and the dashboard rendered exactly as before. Click the mark: expect to land on `/terminal` again (via `/`).

Then restart with `PUBLIC_MODE=1`. Open `/`: expect the placeholder heading "Ponsnipe". Open `/terminal`: expect the read-only dashboard.

- [ ] **Step 8: Commit**

```bash
git add -A src/app
git commit -m "The terminal moves to /terminal, and the root learns who is asking" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `lib/pool.ts`: the prize pool, read from the fee wallet

**Files:**
- Create: `src/lib/pool.ts`
- Test: `tests/pool.test.ts`

**Interfaces:**
- Consumes: `readClient()` from `@/lib/chain`; `isAddress`, `formatEther` from `viem`.
- Produces:
  - `feeWalletAddress(raw?: string): Address | null` — the configured fee wallet, or null when unset or malformed.
  - `fmtPool(eth: number): string` — `"0.412 ETH"`, three decimals.
  - `interface PoolInfo { wallet: Address; eth: number }`
  - `poolBalance(): Promise<PoolInfo | null>` — cached 60s; null when no fee wallet or the read fails.

- [ ] **Step 1: Write the failing tests**

Create `tests/pool.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { feeWalletAddress, fmtPool } from "../src/lib/pool";

test("no fee wallet means no pool", () => {
  assert.equal(feeWalletAddress(""), null);
  assert.equal(feeWalletAddress(undefined), null);
  assert.equal(feeWalletAddress("   "), null);
});

test("a malformed fee wallet is treated as unset, not as an address", () => {
  assert.equal(feeWalletAddress("0x1234"), null);
  assert.equal(feeWalletAddress("not-an-address"), null);
});

test("a real address is returned trimmed, whatever its case", () => {
  const a = "0x5782bc813be39efb6ca57b16e43ca92f48ffa9a0";
  assert.equal(feeWalletAddress(`  ${a}  `), a);
  // The same test fee.ts applies in the browser: a hex shape, not a checksum.
  assert.equal(feeWalletAddress(a.toUpperCase().replace("0X", "0x")), a.toUpperCase().replace("0X", "0x"));
});

test("the pool is shown to three decimals, never more, never fewer", () => {
  assert.equal(fmtPool(0.41234), "0.412 ETH");
  assert.equal(fmtPool(1), "1.000 ETH");
  assert.equal(fmtPool(0), "0.000 ETH");
  assert.equal(fmtPool(12.3456789), "12.346 ETH");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test tests/pool.test.ts`
Expected: FAIL, cannot find module `../src/lib/pool`.

- [ ] **Step 3: Write the module**

Create `src/lib/pool.ts`:

```ts
import { formatEther, type Address } from "viem";
import { readClient } from "./chain";

/**
 * The prize pool is the fee wallet's balance.
 *
 * A competition funded by a number on a website is a promise; one funded by
 * an address is a fact. So the pool is never a figure typed somewhere — it is
 * read from the chain, and the address is shown beside it so anybody can
 * check both.
 *
 * NEXT_PUBLIC_ because the browser sends the fee (see src/app/fee.ts); the
 * server reads the same variable, and applies the same shape test rather than
 * a checksum, so the two can never disagree about whether a wallet is set.
 */
export function feeWalletAddress(
  raw: string | undefined = process.env.NEXT_PUBLIC_FEE_WALLET,
): Address | null {
  const t = (raw ?? "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(t) ? (t as Address) : null;
}

export interface PoolInfo {
  wallet: Address;
  /** Balance in ETH. */
  eth: number;
}

/** Three decimals: enough to see a fee land, not enough to look like noise. */
export function fmtPool(eth: number): string {
  return `${eth.toFixed(3)} ETH`;
}

const TTL_MS = 60_000;
const g = globalThis as typeof globalThis & {
  __ponsPool?: { at: number; data: PoolInfo | null };
};

/**
 * The pool right now, or null when there is no fee wallet or the read fails.
 *
 * Cached for a minute in module scope. The landing page is force-dynamic, and
 * one balance read per request would otherwise be one RPC call per visitor.
 */
export async function poolBalance(): Promise<PoolInfo | null> {
  const wallet = feeWalletAddress();
  if (!wallet) return null;
  const hit = g.__ponsPool;
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  try {
    const wei = await readClient().getBalance({ address: wallet });
    const data = { wallet, eth: Number(formatEther(wei)) };
    g.__ponsPool = { at: Date.now(), data };
    return data;
  } catch {
    // A failed read is not a zero pool. Keep whatever was last known.
    return hit?.data ?? null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test tests/pool.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/lib/pool.ts tests/pool.test.ts
git commit -m "The prize pool is a balance, read from the address that holds it" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `lib/targets.ts`: lift the targets logic out of the route, add `pickPins`

**Files:**
- Create: `src/lib/targets.ts`
- Modify: `src/app/api/arcade/targets/route.ts` (becomes a wrapper)
- Test: `tests/targets.test.ts`

**Interfaces:**
- Consumes: `db()` from `@/lib/db`.
- Produces:
  - `interface Target { symbol: string; price: number; changePct: number; launches: number }`
  - `interface Pin { symbol: string; changePct: number; up: boolean }`
  - `pickPins(targets: Target[], n = 3): Pin[]` — the `n` most-used targets, most used first; `up` is `changePct >= 0`.
  - `loadTargets(): Promise<Target[]>` — the cached list the game already used.

- [ ] **Step 1: Write the failing tests**

Create `tests/targets.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPins, type Target } from "../src/lib/targets";

const t = (symbol: string, launches: number, changePct: number): Target => ({
  symbol,
  launches,
  changePct,
  price: 100,
});

test("pins are the most-used targets, most used first", () => {
  const pins = pickPins([t("AAPL", 3, 1), t("NVDA", 9, 2), t("SPY", 5, -1), t("TSLA", 7, 0.5)]);
  assert.deepEqual(
    pins.map((p) => p.symbol),
    ["NVDA", "TSLA", "SPY"],
  );
});

test("up is the day's move, and flat counts as up", () => {
  const pins = pickPins([t("A", 3, 1.2), t("B", 2, -0.4), t("C", 1, 0)]);
  assert.deepEqual(
    pins.map((p) => p.up),
    [true, false, true],
  );
});

test("fewer targets than pins is fine, and none is none", () => {
  assert.equal(pickPins([t("A", 1, 1)]).length, 1);
  assert.deepEqual(pickPins([]), []);
});

test("n is honoured and the input is not reordered", () => {
  const input = [t("A", 1, 1), t("B", 2, 1)];
  const pins = pickPins(input, 1);
  assert.deepEqual(pins.map((p) => p.symbol), ["B"]);
  assert.deepEqual(input.map((x) => x.symbol), ["A", "B"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test tests/targets.test.ts`
Expected: FAIL, cannot find module `../src/lib/targets`.

- [ ] **Step 3: Write the module**

Create `src/lib/targets.ts`. The `quote` function and the cache are the current contents of `src/app/api/arcade/targets/route.ts`, moved verbatim; `pickPins` is new:

```ts
import { db } from "./db";

/**
 * The stocks to shoot at, and which way they moved today.
 *
 * Taken from the quote assets the feed is actually using rather than a list
 * somebody typed, so the targets are the shares this chain trades against. The
 * day's move decides what each one does in the game: the ones that are up are
 * worth points, the ones that are down shoot back.
 *
 * Lifted out of the route handler so the landing page can pin the same three
 * tickers to its target on the server, in the first paint, without an HTTP
 * round trip to itself.
 */
export interface Target {
  symbol: string;
  price: number;
  changePct: number;
  /** How many live launches are priced against it — how common it is here. */
  launches: number;
}

/** One ticker pinned to the hero's target. */
export interface Pin {
  symbol: string;
  changePct: number;
  /** Up or flat on the day. The game treats flat as green too. */
  up: boolean;
}

/** The `n` most-used targets, most used first. Pure; does not touch the input. */
export function pickPins(targets: Target[], n = 3): Pin[] {
  return [...targets]
    .sort((a, b) => b.launches - a.launches)
    .slice(0, Math.max(0, n))
    .map((t) => ({ symbol: t.symbol, changePct: t.changePct, up: t.changePct >= 0 }));
}

const TTL_MS = 120_000;
const g = globalThis as typeof globalThis & {
  __ponsTargets?: { at: number; data: Target[] };
};

/**
 * Price and day's move in one call.
 *
 * The same Yahoo chart endpoint usd.ts uses, which needs no key. Its meta
 * carries the previous close beside the current price, so the move costs
 * nothing extra to work out.
 */
async function quote(symbol: string): Promise<{ price: number; changePct: number } | null> {
  if (process.env.DISABLE_PRICE_FEEDS === "1") return null;
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`,
      { signal: AbortSignal.timeout(7000), headers: { "user-agent": "Mozilla/5.0" } },
    );
    if (!r.ok) return null;
    const j = (await r.json()) as {
      chart?: {
        result?: {
          meta?: { regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number; currency?: string };
        }[];
      };
    };
    const m = j?.chart?.result?.[0]?.meta;
    if (!m || m.currency !== "USD") return null;
    const price = Number(m.regularMarketPrice);
    const prev = Number(m.chartPreviousClose ?? m.previousClose);
    if (!(price > 0)) return null;
    // No previous close means no move to report — flat rather than invented.
    const changePct = prev > 0 ? ((price - prev) / prev) * 100 : 0;
    return { price, changePct };
  } catch {
    return null;
  }
}

/** The targets, cached two minutes. Throws only if the database is unreadable. */
export async function loadTargets(): Promise<Target[]> {
  const hit = g.__ponsTargets;
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const rows = db()
    .prepare(
      `SELECT quote_symbol AS symbol, COUNT(*) AS launches
         FROM feed_tokens
        WHERE quote_is_native = 0 AND quote_symbol IS NOT NULL
        GROUP BY quote_symbol ORDER BY launches DESC LIMIT 24`,
    )
    .all() as { symbol: string; launches: number }[];

  // Stablecoins and wrapped crypto are not shares and have no day to have.
  const skip = new Set(["USDG", "USDC", "USDT", "DAI", "CBBTC", "WBTC", "WETH", "?"]);
  const want = rows.filter((r) => !skip.has(r.symbol.toUpperCase()));

  const got = await Promise.all(
    want.map(async (r) => {
      const q = await quote(r.symbol);
      return q ? { symbol: r.symbol, launches: r.launches, ...q } : null;
    }),
  );
  const targets = got.filter(Boolean) as Target[];
  g.__ponsTargets = { at: Date.now(), data: targets };
  return targets;
}
```

- [ ] **Step 4: Make the route a wrapper**

Replace the whole of `src/app/api/arcade/targets/route.ts` with:

```ts
import { json, errorJson } from "@/lib/api";
import { loadTargets } from "@/lib/targets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The stocks to shoot at. The logic lives in lib/targets so a page can call it too. */
export async function GET() {
  try {
    return json({ targets: await loadTargets() });
  } catch (err) {
    return errorJson(err instanceof Error ? err.message : "could not load targets", 502);
  }
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `node --import tsx --test tests/targets.test.ts && npm run typecheck && npm test`
Expected: 4 passing in the new file; typecheck clean; the full suite green.

- [ ] **Step 6: Check the route still answers**

With the dev server running, open `/api/arcade/targets`. Expected: `{"targets":[...]}` with the same shape as before (symbol, price, changePct, launches), or `[]` if price feeds are disabled.

- [ ] **Step 7: Commit**

```bash
git add src/lib/targets.ts src/app/api/arcade/targets/route.ts tests/targets.test.ts
git commit -m "The range's targets move to a library, so a page can pin them too" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The site shell: layout, fonts, `site.css`, nav, footer

**Files:**
- Create: `src/app/(site)/layout.tsx`
- Create: `src/app/(site)/site.css`
- Create: `src/app/(site)/SiteNav.tsx`
- Create: `src/app/(site)/SiteFooter.tsx`

**Interfaces:**
- Consumes: `Logo` from `@/app/Logo`; `feeWalletAddress` from `@/lib/pool`; `EXPLORER` from `@/lib/format`.
- Produces: a `.site` wrapper carrying `--font-display` and `--font-mono-site`; nav and footer on every site page; CSS classes used by Tasks 5-8 (listed in the stylesheet below).

- [ ] **Step 1: Read the font docs**

Read `node_modules/next/dist/docs/01-app/01-getting-started/13-fonts.md` and the `variable`, `axes`, `weight` sections of `node_modules/next/dist/docs/01-app/03-api-reference/02-components/font.md`.

- [ ] **Step 2: Write the layout**

Create `src/app/(site)/layout.tsx`:

```tsx
import { Fraunces, JetBrains_Mono } from "next/font/google";
import "./site.css";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";

/*
 * Fonts through next/font, which downloads them at build time and serves them
 * from this origin. That is what makes them legal under the production CSP's
 * font-src 'self'. If the container build ever runs without network, swap
 * these two calls for next/font/local with the files committed under ./fonts.
 */
const display = Fraunces({
  subsets: ["latin"],
  weight: "variable",
  style: ["normal", "italic"],
  axes: ["opsz", "SOFT"],
  variable: "--font-display",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: "variable",
  variable: "--font-mono-site",
  display: "swap",
});

/**
 * The site shell: nav, page, footer.
 *
 * Nested under the root layout, not a second root, so moving between the
 * site and the terminal is a client navigation rather than a full reload.
 * Everything Sherwood is scoped under .site; the terminal never sees it.
 */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`site ${display.variable} ${mono.variable}`}>
      <SiteNav />
      {children}
      <SiteFooter />
    </div>
  );
}
```

- [ ] **Step 3: Write the nav**

Create `src/app/(site)/SiteNav.tsx`:

```tsx
import Link from "next/link";
import Logo from "@/app/Logo";

/**
 * Mark, wordmark, four links, one button.
 *
 * No Connect here: the landing page has nothing for a wallet to do. The one
 * button-styled item is the terminal, which is where a wallet becomes useful.
 * On narrow screens the middle collapses to Range, Play, Terminal.
 */
export default function SiteNav() {
  return (
    <header className="snav">
      <Link href="/" className="snav-lockup" aria-label="Ponsnipe, front door">
        <Logo size={30} />
        <img
          className="snav-word"
          src="/brand/wordmark.webp"
          srcSet="/brand/wordmark.webp 1x, /brand/wordmark@2x.webp 2x"
          alt="Ponsnipe"
          decoding="async"
        />
      </Link>
      <nav className="snav-links" aria-label="Site">
        <Link href="/range">Range</Link>
        <Link href="/play">
          <span className="snav-long">Paper sniper</span>
          <span className="snav-short">Play</span>
        </Link>
        <Link href="/range#board" className="snav-board">
          Board
        </Link>
        <Link href="/terminal" className="btn btn-sm snav-cta">
          Terminal
        </Link>
      </nav>
    </header>
  );
}
```

- [ ] **Step 4: Write the footer**

Create `src/app/(site)/SiteFooter.tsx`:

```tsx
import { EXPLORER, shortAddr } from "@/lib/format";
import { feeWalletAddress } from "@/lib/pool";

const REPO_URL = (process.env.NEXT_PUBLIC_REPO_URL ?? "").trim();
const X_URL = (process.env.NEXT_PUBLIC_X_URL ?? "").trim();

/**
 * One line, mono. Each link appears only when there is somewhere for it to go:
 * the terminal already hides its Source link the same way, and a footer link
 * to nowhere is worse than no link.
 */
export default function SiteFooter() {
  const fee = feeWalletAddress();
  return (
    <footer className="sfoot">
      {X_URL && (
        <a href={X_URL} target="_blank" rel="noopener noreferrer">
          X
        </a>
      )}
      {REPO_URL && (
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
          Source
        </a>
      )}
      {fee && (
        <a
          href={`${EXPLORER}/address/${fee}`}
          target="_blank"
          rel="noopener noreferrer"
          title="The fee wallet. Its balance is the prize pool."
        >
          Fee wallet {shortAddr(fee)}
        </a>
      )}
      {REPO_URL && (
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
          Run your own
        </a>
      )}
      <span className="sfoot-note">Robinhood Chain</span>
    </footer>
  );
}
```

- [ ] **Step 5: Write the stylesheet**

Create `src/app/(site)/site.css`. This is the whole Sherwood layer; later tasks add markup, not rules. Every selector starts with `.site`.

```css
/* ══════════════════════════════════════════════════════════════════════════
 * PONSNIPE — the site layer
 *
 * Sherwood at night. Forest black, gold as firelight, lime as the bowstring.
 * One motif, the butt, carrying real data. Everything here is scoped under
 * .site so no rule reaches the terminal, and the terminal's tokens (lime,
 * gold, up, down, spacing, radii) are the base this builds on.
 *
 * Rules kept from globals.css: space on the 4px grid, radius by role, colour
 * carries meaning, depth from surface steps not glow.
 * ══════════════════════════════════════════════════════════════════════════ */

.site {
  --forest-0: #070b08;   /* page ground */
  --forest-1: #0d140f;   /* panels on the ground */
  --forest-2: #121b15;   /* raised: rows, headers */
  --moon: #e9efe6;       /* primary text */
  --moss: #aeb9ab;       /* secondary text */
  --bark: #6f7d6c;       /* tertiary text, labels */
  --hair-w: rgba(255, 255, 255, 0.07);
  --display: var(--font-display), Georgia, "Times New Roman", serif;
  --mono-site: var(--font-mono-site), ui-monospace, "SF Mono", Menlo, monospace;

  min-height: 100vh;
  background: var(--forest-0);
  color: var(--moon);
  display: flex;
  flex-direction: column;
}
.site a { color: inherit; }
.site .num, .site .mono, .site .lab { font-family: var(--mono-site); font-variant-numeric: tabular-nums; }
.site .lab {
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--bark);
}
.site .up { color: var(--up); }
.site .down { color: var(--down); }

/* Display type: three sizes and no more. */
.site .display {
  font-family: var(--display);
  font-weight: 700;
  font-variation-settings: "opsz" 144, "SOFT" 30;
  letter-spacing: -0.02em;
  line-height: 0.98;
  color: #f2f5ee;
}
.site .display em { font-style: italic; font-weight: 500; color: var(--gold); }

/* Buttons: the terminal's .btn, sized for a page rather than a panel. */
.site .hbtn { height: 48px; padding: 0 22px; font-size: 15px; width: auto; text-decoration: none; }
.site .hbtn.btn-primary { box-shadow: 0 8px 24px -12px rgba(195, 245, 60, 0.6); }
.site .ghost { background: rgba(255, 255, 255, 0.02); border-color: rgba(233, 239, 230, 0.16); color: var(--moon); }
.site .ghost:hover:not(:disabled) { background: rgba(255, 255, 255, 0.05); }

/* Column. */
.site .col { width: min(1180px, 100% - var(--sp-8)); margin: 0 auto; }

/* ── nav ─────────────────────────────────────────────────────────────────── */
.site .snav {
  height: 68px;
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  width: min(1180px, 100% - var(--sp-8));
  margin: 0 auto;
}
.site .snav-lockup { display: flex; align-items: center; gap: 10px; text-decoration: none; min-width: 0; }
.site .snav-word { display: block; height: 22px; width: auto; }
.site .snav-links { margin-left: auto; display: flex; align-items: center; gap: var(--sp-6); font-size: 14px; }
.site .snav-links a { text-decoration: none; color: var(--moss); }
.site .snav-links a:hover { color: var(--moon); }
.site .snav-cta { color: var(--moon); }
.site .snav-short { display: none; }
@media (max-width: 720px) {
  .site .snav-links { gap: var(--sp-4); }
  .site .snav-long, .site .snav-board { display: none; }
  .site .snav-short { display: inline; }
}

/* ── footer ──────────────────────────────────────────────────────────────── */
.site .sfoot {
  margin-top: auto;
  padding: var(--sp-7) 0 var(--sp-8);
  width: min(1180px, 100% - var(--sp-8));
  margin-left: auto;
  margin-right: auto;
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3) var(--sp-6);
  font-family: var(--mono-site);
  font-size: 12px;
  letter-spacing: 0.04em;
  color: var(--bark);
  border-top: 1px solid var(--hair-w);
}
.site .sfoot a { text-decoration: none; }
.site .sfoot a:hover { color: var(--moon); }
.site .sfoot-note { margin-left: auto; }

/* ── page sections ───────────────────────────────────────────────────────── */
.site .site-main { display: flex; flex-direction: column; gap: var(--sp-8); }
.site .sect { width: min(1180px, 100% - var(--sp-8)); margin: 0 auto; display: grid; gap: var(--sp-5); }
.site .sect-h2 { font-size: clamp(30px, 4vw, 44px); }
.site .sect-lab { display: flex; align-items: center; gap: 12px; color: var(--gold); }
.site .sect-lab::before { content: ""; width: 26px; height: 1px; background: var(--gold); }
.site .sect-sub { color: var(--moss); font-size: 17px; max-width: 60ch; margin: 0; }

/* ── hero ────────────────────────────────────────────────────────────────── */
.site .hero {
  position: relative;
  overflow: hidden;
  background: radial-gradient(1400px 700px at 70% 40%, #101c14 0%, var(--forest-0) 55%, #050706 100%);
}
/* Grain on the hero ground only. An SVG noise tile at low opacity; a wall of
   small numbers cannot compete with texture, so nothing below gets it. */
.site .hero::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.5;
  mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 .18 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
.site .hero-in {
  position: relative;
  z-index: 1;
  width: min(1180px, 100% - var(--sp-8));
  margin: 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
  gap: var(--sp-8);
  align-items: center;
  padding: var(--sp-8) 0 calc(var(--sp-8) + 60px);
  min-height: 560px;
}
.site .hero-copy { display: grid; gap: var(--sp-5); max-width: 560px; }
.site .hero-h1 { font-size: clamp(48px, 7vw, 84px); margin: 0; }
.site .hero-sub { font-size: 18px; line-height: 1.5; color: var(--moss); max-width: 470px; margin: 0; }
.site .hero-cta { display: flex; gap: var(--sp-3); align-items: center; flex-wrap: wrap; }
.site .hero-pool { font-family: var(--mono-site); font-size: 12.5px; color: var(--bark); letter-spacing: 0.02em; margin: 0; }
.site .hero-pool b { color: var(--gold); font-weight: 500; }
.site .hero-pool a { text-decoration: none; border-bottom: 1px solid rgba(240, 180, 41, 0.3); }
.site .hero-side { position: relative; display: grid; gap: var(--sp-6); justify-items: end; }

/* ── the butt ────────────────────────────────────────────────────────────── */
.site .butt {
  position: relative;
  border-radius: 50%;
  flex: none;
  background: radial-gradient(circle at 50% 50%,
    var(--gold) 0 9%, #1a1f1a 9% 10.5%,
    #d9431f 10.5% 21%, #1a1f1a 21% 22.5%,
    #2a6bd6 22.5% 33%, #1a1f1a 33% 34.5%,
    #1c2a1f 34.5% 45%, #0f1611 45% 46.5%,
    #e6e2d5 46.5% 50%);
  box-shadow: 0 60px 120px -40px rgba(0, 0, 0, 0.9), inset 0 0 0 1px rgba(255, 255, 255, 0.06);
}
.site .butt-hero { width: min(430px, 80vw); height: min(430px, 80vw); transform: rotate(-6deg); }
.site .butt-hero::before {
  content: "";
  position: absolute;
  inset: -46px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(240, 180, 41, 0.18), transparent 62%);
  z-index: -1;
}
.site .butt-arrow {
  position: absolute;
  left: -150px;
  top: 47%;
  width: 190px;
  height: 2px;
  background: linear-gradient(90deg, transparent, #d9c9a2 40%, var(--gold));
  transform: rotate(-8deg);
  transform-origin: right center;
}
.site .butt-arrow::after {
  content: "";
  position: absolute;
  right: -2px;
  top: -4px;
  border-left: 10px solid var(--gold);
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
}
.site .pin {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--mono-site);
  font-size: 12.5px;
  font-weight: 600;
  padding: 7px 11px;
  border-radius: var(--r-ctl);
  background: #0b100c;
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 8px 20px -8px #000;
  transform: rotate(6deg); /* undo the butt's tilt so text sits level */
  animation: pin-settle 420ms cubic-bezier(0.2, 0, 0.2, 1) both;
}
.site .pin::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.site .pin-up { color: var(--up); }
.site .pin-dn { color: var(--down); }
.site .pin i { font-style: normal; color: var(--moon); }
.site .pin-1 { left: -8%; top: 36%; animation-delay: 120ms; }
.site .pin-2 { right: -10%; top: 6%; animation-delay: 240ms; }
.site .pin-3 { right: -4%; bottom: 8%; animation-delay: 360ms; }
@keyframes pin-settle {
  from { opacity: 0; transform: rotate(6deg) translateY(-10px) scale(1.06); }
  to { opacity: 1; transform: rotate(6deg) translateY(0) scale(1); }
}

/* ── the board card ──────────────────────────────────────────────────────── */
.site .board {
  width: min(330px, 100%);
  background: var(--s1);
  border: 1px solid var(--line);
  border-radius: var(--r-panel);
  box-shadow: var(--sh-3);
  overflow: hidden;
}
.site .board-h {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
  color: var(--t2);
}
.site .board-h .gold { color: var(--gold); }
.site .board-row {
  display: grid;
  grid-template-columns: 22px 1fr auto;
  gap: 12px;
  align-items: center;
  padding: 11px 16px;
  border-bottom: 1px solid var(--hair);
  font-size: 13.5px;
  animation: fade-in 180ms cubic-bezier(0.2, 0, 0.2, 1) both;
}
.site .board-row:nth-child(2) { animation-delay: 60ms; }
.site .board-row:nth-child(3) { animation-delay: 120ms; }
.site .board-row:nth-child(4) { animation-delay: 180ms; }
.site .board-row .n { color: var(--t3); font-size: 12px; }
.site .board-row:first-of-type .n { color: var(--gold); }
.site .board-row .w { color: var(--t1); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.site .board-row .p { color: var(--lime); font-weight: 500; }
.site .board-empty { padding: 16px; color: var(--t3); font-size: 13px; margin: 0; }
.site .board-f { padding: 12px 16px; font-size: 11.5px; color: var(--t3); display: flex; justify-content: space-between; gap: var(--sp-3); }
.site .board-f b { color: var(--gold); font-weight: 500; }
.site .board-f a { text-decoration: none; }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }

/* ── the tree line ───────────────────────────────────────────────────────── */
.site .trees {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  height: 150px;
  pointer-events: none;
  background:
    radial-gradient(60px 130px at 6% 100%, #040604 60%, transparent 61%),
    radial-gradient(90px 190px at 16% 100%, #040604 60%, transparent 61%),
    radial-gradient(50px 110px at 27% 100%, #040604 60%, transparent 61%),
    radial-gradient(80px 160px at 40% 100%, #040604 60%, transparent 61%),
    radial-gradient(60px 120px at 55% 100%, #040604 60%, transparent 61%),
    radial-gradient(110px 210px at 72% 100%, #040604 60%, transparent 61%),
    radial-gradient(70px 140px at 87% 100%, #040604 60%, transparent 61%),
    radial-gradient(90px 180px at 98% 100%, #040604 60%, transparent 61%),
    linear-gradient(to top, #040604 30px, transparent 100%);
}

/* ── paper sniper, on the page ───────────────────────────────────────────── */
.site .site-paper { display: grid; justify-items: start; }
.site .site-paper .play-card { width: min(520px, 100%); background: var(--forest-1); border-color: var(--hair-w); }
.site .site-paper .play-wait { margin-top: 0; color: var(--bark); }

/* ── the range window ────────────────────────────────────────────────────── */
.site .rwin {
  position: relative;
  overflow: hidden;
  border-radius: var(--r-panel);
  border: 1px solid var(--hair-w);
  min-height: 340px;
  background: radial-gradient(900px 300px at 50% 115%, #101c14, var(--forest-0) 70%);
  display: grid;
  place-items: center;
}
.site .rwin .butt { position: absolute; opacity: 0.85; }
.site .rwin .b1 { width: 120px; height: 120px; left: 18%; top: 28%; }
.site .rwin .b2 { width: 74px; height: 74px; left: 48%; top: 18%; opacity: 0.6; }
.site .rwin .b3 { width: 150px; height: 150px; right: 14%; top: 32%; }
.site .rwin .trees { height: 90px; }
.site .rwin-cta { position: relative; z-index: 1; }
.site .rwin-cap { color: var(--moss); font-size: 15px; margin: 0; }

/* ── the terminal section ────────────────────────────────────────────────── */
.site .claims { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-6); }
.site .claim b { display: block; font-size: clamp(34px, 4vw, 48px); margin-bottom: 4px; }
.site .claim span { color: var(--bark); }
.site .strip { border: 1px solid var(--hair-w); border-radius: var(--r-panel); background: var(--forest-1); overflow: hidden; }
.site .strip-row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto auto auto;
  gap: var(--sp-4);
  align-items: center;
  padding: 10px 16px;
  border-top: 1px solid var(--hair-w);
  font-size: 13.5px;
}
.site .strip-row:first-child { border-top: 0; }
.site .strip-row img { width: 28px; height: 28px; border-radius: 6px; object-fit: cover; background: var(--forest-2); }
.site .strip-row .sym { font-weight: 600; color: var(--moon); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.site .strip-row .sym small { font-weight: 400; color: var(--bark); margin-left: 8px; }
.site .strip-row .q { color: var(--moss); }
.site .strip-row .age { color: var(--bark); }
.site .strip-row .mc { color: var(--moon); font-weight: 500; }

/* ── the honest part ─────────────────────────────────────────────────────── */
.site .honest { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-6); }
.site .honest b { display: block; font-size: clamp(40px, 5vw, 64px); color: var(--gold); margin-bottom: 4px; }
.site .honest span { color: var(--moss); }

/* ── the range page ──────────────────────────────────────────────────────── */
.site .range { padding: 0 0 var(--sp-8); }
.site .range-head { width: min(1220px, 100%); display: flex; align-items: center; gap: var(--sp-5); padding: var(--sp-4) 0 var(--sp-2); }
.site .range-head h1 { font-size: clamp(28px, 4vw, 40px); margin: 0; }
.site .range-head p { margin: 4px 0 0; color: var(--moss); }
.site .range-grid { width: min(1220px, 100%); display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: var(--sp-6); align-items: start; }
.site .range-grid .arc-stage { width: 100%; }
.site .range-grid .arc-board { width: auto; }
.site .range-grid .arc-rows li:nth-child(odd) { background: var(--forest-1); }

/* ── responsive ──────────────────────────────────────────────────────────── */
@media (max-width: 940px) {
  .site .claims, .site .honest { grid-template-columns: 1fr; gap: var(--sp-5); }
  .site .range-grid { grid-template-columns: 1fr; }
  .site .strip-row { grid-template-columns: 28px minmax(0, 1fr) auto; }
  .site .strip-row .q, .site .strip-row .age { display: none; }
}
@media (max-width: 720px) {
  .site .hero-in { grid-template-columns: 1fr; padding-top: var(--sp-6); min-height: 0; gap: var(--sp-6); }
  .site .hero-side { justify-items: stretch; }
  .site .butt-hero {
    position: absolute;
    right: -20%;
    top: -6%;
    width: 300px;
    height: 300px;
    opacity: 0.22;
    z-index: -1;
  }
  .site .butt-arrow, .site .pin { display: none; }
  .site .board { width: 100%; }
  .site .hero-cta .hbtn { width: 100%; }
}

/* Everything honours reduced motion. Nothing animates behind text anyway. */
@media (prefers-reduced-motion: reduce) {
  .site .pin, .site .board-row { animation: none; }
}
```

- [ ] **Step 6: Typecheck and look at it**

Run: `npm run typecheck`
Expected: clean.

Start the dev server with `PUBLIC_MODE=1`. Open `/`. Expected: forest-black page, the nav with mark, wordmark, Range, Paper sniper, Board and a Terminal button, the placeholder heading, and the footer line at the bottom. Check the network panel: font files are served from this origin under `/_next/static/media/`, and no request goes to `fonts.googleapis.com` or `fonts.gstatic.com`.

Resize to 375px wide. Expected: the nav shows Range, Play, Terminal.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(site)"
git commit -m "A shell for the site: nav, footer, and the Sherwood layer" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The hero: butt, pins, board card, and the landing page's data

**Files:**
- Create: `src/app/(site)/Butt.tsx`
- Create: `src/app/(site)/BoardCard.tsx`
- Create: `src/app/(site)/Hero.tsx`
- Modify: `src/app/(site)/page.tsx` (replace the placeholder)

**Interfaces:**
- Consumes: `pickPins`, `loadTargets`, `Pin` from `@/lib/targets`; `top`, `weekOf`, `weekEnds`, `Score` from `@/lib/arcade`; `poolBalance`, `fmtPool`, `PoolInfo` from `@/lib/pool`; `EXPLORER`, `shortAddr` from `@/lib/format`.
- Produces:
  - `Butt({ size?: number; className?: string; children?: ReactNode })`
  - `BoardCard({ rows: Score[]; endsAt: number; pool: PoolInfo | null })`
  - `Hero({ pins: Pin[]; board: Score[]; endsAt: number; pool: PoolInfo | null })`
  - In `page.tsx`, `safely<T>(work, fallback)` used by later tasks.

- [ ] **Step 1: The butt**

Create `src/app/(site)/Butt.tsx`:

```tsx
import type { ReactNode } from "react";

/**
 * The one motif. Concentric rings in CSS: gold centre, red, blue, dark green,
 * cream. Drawn once, used in the hero with pins, in the range window at three
 * distances, and beside the range page's title.
 *
 * No hooks, so it renders on the server and inside client pages alike.
 */
export default function Butt({
  size,
  className = "",
  children,
}: {
  size?: number;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={`butt ${className}`.trim()}
      style={size ? { width: size, height: size } : undefined}
      aria-hidden="true"
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 2: The board card**

Create `src/app/(site)/BoardCard.tsx`:

```tsx
import type { Score } from "@/lib/arcade";
import { EXPLORER, shortAddr } from "@/lib/format";
import { fmtPool, type PoolInfo } from "@/lib/pool";

/** "Mon 15 Sep · 00:00 UTC". Always a Monday midnight by construction. */
function endsLabel(endsAt: number): string {
  const d = new Date(endsAt);
  const day = d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  return `${day} · 00:00 UTC`;
}

/**
 * The top of this week's board, and the pool that pays it.
 *
 * The same surface and hairline the terminal uses, because this card is the
 * one honest pitch on the page: a leaderboard with a public wallet under it.
 */
export default function BoardCard({
  rows,
  endsAt,
  pool,
}: {
  rows: Score[];
  endsAt: number;
  pool: PoolInfo | null;
}) {
  return (
    <aside className="board" aria-label="This week's board">
      <div className="board-h lab">
        <span>This week</span>
        <span className="gold">ends {endsLabel(endsAt)}</span>
      </div>
      {rows.length === 0 ? (
        <p className="board-empty">Nobody has posted a score yet.</p>
      ) : (
        rows.slice(0, 3).map((r, i) => (
          <div className="board-row" key={r.wallet}>
            <span className="n mono">{String(i + 1).padStart(2, "0")}</span>
            <span className="w mono">{r.name || shortAddr(r.wallet)}</span>
            <span className="p num">{r.points.toLocaleString("en-GB")}</span>
          </div>
        ))
      )}
      {pool && (
        <div className="board-f mono">
          <span>
            pool <b>{fmtPool(pool.eth)}</b>
          </span>
          <a href={`${EXPLORER}/address/${pool.wallet}`} target="_blank" rel="noopener noreferrer">
            {shortAddr(pool.wallet)} ↗
          </a>
        </div>
      )}
    </aside>
  );
}
```

- [ ] **Step 3: The hero**

Create `src/app/(site)/Hero.tsx`:

```tsx
import Link from "next/link";
import type { Score } from "@/lib/arcade";
import { EXPLORER } from "@/lib/format";
import { fmtPool, type PoolInfo } from "@/lib/pool";
import type { Pin } from "@/lib/targets";
import BoardCard from "./BoardCard";
import Butt from "./Butt";

/**
 * Copy on the left, the butt and the board on the right.
 *
 * The pins are today's range targets: the shares this chain trades against,
 * green when up on the day and red when down. Real data on the motif, which
 * is the only reason to have a motif.
 */
export default function Hero({
  pins,
  board,
  endsAt,
  pool,
}: {
  pins: Pin[];
  board: Score[];
  endsAt: number;
  pool: PoolInfo | null;
}) {
  return (
    <section className="hero">
      <div className="hero-in">
        <div className="hero-copy">
          <p className="lab sect-lab">Sherwood · Robinhood Chain</p>
          <h1 className="display hero-h1">
            Pick your shot.
            <br />
            <em>Loose it.</em>
            <br />
            Walk away.
          </h1>
          <p className="hero-sub">
            Every pons launch, the second it exists. Exits set before you&apos;re in. And a
            range where today&apos;s tickers are the targets.
          </p>
          <div className="hero-cta">
            <Link href="/range" className="btn btn-primary hbtn">
              Draw the bow
            </Link>
            <a href="#paper" className="btn hbtn ghost">
              Paper sniper · 8 real launches
            </a>
          </div>
          {pool && (
            <p className="hero-pool">
              This week&apos;s pool <b>{fmtPool(pool.eth)}</b> ·{" "}
              <a href={`${EXPLORER}/address/${pool.wallet}`} target="_blank" rel="noopener noreferrer">
                paid from an address anyone can check
              </a>
            </p>
          )}
        </div>

        <div className="hero-side">
          <Butt className="butt-hero">
            <span className="butt-arrow" />
            {pins.slice(0, 3).map((p, i) => (
              <span key={p.symbol} className={`pin pin-${i + 1} ${p.up ? "pin-up" : "pin-dn"}`}>
                <i>{p.symbol}</i>
                {p.changePct >= 0 ? "+" : ""}
                {p.changePct.toFixed(1)}%
              </span>
            ))}
          </Butt>
          <BoardCard rows={board} endsAt={endsAt} pool={pool} />
        </div>
      </div>
      <div className="trees" aria-hidden="true" />
    </section>
  );
}
```

- [ ] **Step 4: The landing page, with data**

Replace `src/app/(site)/page.tsx` with:

```tsx
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { top, weekEnds, weekOf, type Score } from "@/lib/arcade";
import { poolBalance, type PoolInfo } from "@/lib/pool";
import { loadTargets, pickPins, type Pin } from "@/lib/targets";
import Hero from "./Hero";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Ponsnipe — pick your shot",
  description:
    "Every pons launch on Robinhood Chain the second it exists, exits set before entry, and a range where today's tickers are the targets.",
};

/**
 * Nothing on this page blocks on a network call. Each live section gets its
 * data through here and falls back to a quiet state, never a spinner.
 */
async function safely<T>(work: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await work();
  } catch {
    return fallback;
  }
}

/**
 * The front door.
 *
 * Only a hosted instance has strangers. On a local install the root goes
 * straight to the tool, so `npm run dev` still opens the terminal.
 */
export default async function Landing() {
  if (!env.publicMode) redirect("/terminal");

  const week = weekOf();
  const [board, pins, pool] = await Promise.all([
    safely<Score[]>(() => top(3, week), []),
    safely<Pin[]>(async () => pickPins(await loadTargets()), []),
    safely<PoolInfo | null>(() => poolBalance(), null),
  ]);

  return (
    <main className="site-main">
      <Hero pins={pins} board={board} endsAt={weekEnds(week)} pool={pool} />
    </main>
  );
}
```

- [ ] **Step 5: Typecheck and look at it**

Run: `npm run typecheck`
Expected: clean.

With `PUBLIC_MODE=1`, open `/`. Expected: the hero as designed. The headline in Fraunces with "Loose it." in italic gold; two buttons; the butt tilted with three ticker pins (or none if price feeds are off); the board card with three rows or "Nobody has posted a score yet."; the tree line along the bottom. The pool line appears only if `NEXT_PUBLIC_FEE_WALLET` is set in `.env`.

Check the console: no errors, no hydration warnings.

Resize to 375px. Expected: copy, then the board card full width, the butt faint behind the headline, pins hidden, no horizontal scroll.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(site)"
git commit -m "The hero: a butt with today's tickers on it, and the board beside it" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The paper sniper, lifted into a component and dealt on the page

**Files:**
- Create: `src/app/(site)/PaperSniper.tsx`
- Create: `src/app/(site)/play/page.tsx`
- Delete: `src/app/play/page.tsx`
- Modify: `src/app/(site)/page.tsx` (add the section)

**Interfaces:**
- Produces: `PaperSniper()` default export, a client component with no props that renders the whole game.

- [ ] **Step 1: Create the component**

Create `src/app/(site)/PaperSniper.tsx`. This is the body of the current `src/app/play/page.tsx` with the `<main>` and its `<header>` removed, the wait states returned as bare paragraphs, and the verdict's buttons changed. Everything else, including the comments, is kept as it is:

```tsx
"use client";

/**
 * The paper sniper.
 *
 * Eight real launches, replayed one at a time, showing only what was knowable
 * at the moment each one appeared. Snipe or skip. Then it tells you what
 * actually happened, because this index holds the answer.
 *
 * It exists because nobody believes the numbers. Told that half of all
 * launches never trade and the median coin lives three minutes, a trader
 * nods and snipes anyway. Watching themselves lose on six of eight, and then
 * being shown which single rule would have skipped five of them, is an
 * argument that survives contact with optimism.
 *
 * No wallet, no money, no connection required — which also makes it the one
 * part of this app a stranger can use immediately. That is why it is dealt on
 * the front door itself, and why this is a component rather than a page.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface Round {
  symbol: string;
  name: string;
  logo: string;
  quoteSymbol: string;
  socials: string;
  description: string;
  devLaunches: number;
  devGraduated: number;
  devTraded: number;
  outcome: { everTraded: boolean; peak: number; held: number; trades: number };
}

/** What one pretend snipe costs, so the running total is in familiar units. */
const STAKE = 0.01;

/**
 * Would the dev filter have skipped this one?
 *
 * The same test the feed's badge uses: three or more launches, most of which
 * nobody ever bought. Kept identical on purpose — the lesson is worthless if
 * the rule taught here is not the rule on offer.
 */
function devFilterSkips(r: Round): boolean {
  const dead = r.devLaunches - r.devTraded;
  return r.devGraduated === 0 && r.devLaunches >= 3 && dead / r.devLaunches >= 0.6;
}

export default function PaperSniper() {
  const [rounds, setRounds] = useState<Round[] | null>(null);
  const [i, setI] = useState(0);
  const [taken, setTaken] = useState<boolean[]>([]);
  const [revealed, setRevealed] = useState(false);

  const deal = useCallback(async () => {
    setRounds(null);
    setI(0);
    setTaken([]);
    setRevealed(false);
    try {
      const r = await fetch("/api/paper?n=8");
      const j = (await r.json()) as { rounds?: Round[] };
      setRounds(j.rounds ?? []);
    } catch {
      setRounds([]);
    }
  }, []);

  useEffect(() => {
    void deal();
  }, [deal]);

  const answer = (snipe: boolean) => {
    setTaken((t) => [...t, snipe]);
    setRevealed(true);
  };

  const next = () => {
    setRevealed(false);
    setI((n) => n + 1);
  };

  if (!rounds) return <p className="play-wait">dealing…</p>;
  if (!rounds.length) {
    return (
      <p className="play-wait">
        Not enough launches indexed yet. The feed needs to run for a few minutes.{" "}
        <button className="btn btn-sm" onClick={() => void deal()}>
          Try again
        </button>
      </p>
    );
  }

  const done = i >= rounds.length;
  const r = rounds[Math.min(i, rounds.length - 1)];

  /* Scored on holding, not on the peak. Nobody sells the top, and a game that
     pretends otherwise teaches the wrong lesson. */
  const pnl = rounds.reduce(
    (sum, x, n) => (taken[n] ? sum + STAKE * (x.outcome.held - 1) : sum),
    0,
  );
  const sniped = taken.filter(Boolean).length;
  const wins = rounds.filter((x, n) => taken[n] && x.outcome.held > 1).length;
  const savedByDev = rounds.filter(
    (x, n) => taken[n] && devFilterSkips(x) && x.outcome.held <= 1,
  ).length;

  if (done) {
    return (
      <section className="play-card play-done">
        <h1 className={pnl >= 0 ? "up" : "down"}>
          {pnl >= 0 ? "+" : ""}
          {pnl.toFixed(4)} ETH
        </h1>
        <p className="play-line">
          You sniped {sniped} of {rounds.length}. {wins} made money.
        </p>
        {/*
          The whole reason this exists. A number nobody argues with, followed
          by the one rule that would have changed it.
        */}
        {savedByDev > 0 && (
          <p className="play-lesson">
            <b>{savedByDev}</b> of your losses were launches by a deployer who had
            already made {rounds.find((x, n) => taken[n] && devFilterSkips(x))?.devLaunches}+
            coins that mostly never traded. The dev filter skips those.
          </p>
        )}
        {sniped === 0 && (
          <p className="play-lesson">
            You skipped everything, which beats most people who do not.
          </p>
        )}
        <div className="play-acts">
          <button className="btn btn-lg" onClick={() => void deal()}>
            Again
          </button>
          <Link href="/range" className="btn btn-primary btn-lg">
            Draw the bow
          </Link>
          <Link href="/terminal" className="btn btn-lg">
            Open the terminal
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="play-card">
      <div className="play-count">
        {i + 1} / {rounds.length}
      </div>

      <div className="play-coin">
        {r.logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="play-logo"
            src={`/api/img?u=${encodeURIComponent(r.logo)}`}
            alt=""
            onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")}
          />
        ) : (
          <div className="play-logo play-logo-blank" />
        )}
        <div>
          <h2>{r.symbol}</h2>
          <p className="play-name">{r.name}</p>
        </div>
      </div>

      {r.description && <p className="play-desc">{r.description}</p>}

      <ul className="play-facts">
        <li>
          priced in <b>{r.quoteSymbol}</b>
        </li>
        <li>{r.socials ? "has a link" : "no link"}</li>
        <li className={devFilterSkips(r) ? "bad" : ""}>
          {r.devLaunches > 1
            ? `dev has made ${r.devLaunches}, ${r.devTraded} ever traded`
            : "dev's first coin"}
        </li>
      </ul>

      {!revealed ? (
        <>
          <p className="play-ask">Two seconds old. That is everything you get.</p>
          <div className="play-acts">
            <button className="btn btn-primary btn-lg" onClick={() => answer(true)}>
              Snipe it — {STAKE} ETH
            </button>
            <button className="btn btn-lg" onClick={() => answer(false)}>
              Skip
            </button>
          </div>
        </>
      ) : (
        <div className="play-reveal">
          <p className={r.outcome.held > 1 ? "up" : "down"}>
            {!r.outcome.everTraded
              ? "Nobody ever bought it."
              : `Peaked at ${r.outcome.peak.toFixed(2)}×, ended at ${r.outcome.held.toFixed(2)}× · ${r.outcome.trades} trades`}
          </p>
          {taken[i] && (
            <p className={STAKE * (r.outcome.held - 1) >= 0 ? "up" : "down"}>
              {STAKE * (r.outcome.held - 1) >= 0 ? "+" : ""}
              {(STAKE * (r.outcome.held - 1)).toFixed(4)} ETH
            </p>
          )}
          <button className="btn btn-primary btn-lg" onClick={next}>
            {i + 1 >= rounds.length ? "See the damage" : "Next"}
          </button>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: The standalone page**

Create `src/app/(site)/play/page.tsx`:

```tsx
import PaperSniper from "../PaperSniper";

/** The paper sniper on its own, for a link that should land on the game. */
export default function PlayPage() {
  return (
    <main className="site-main">
      <section className="sect">
        <p className="lab sect-lab">Paper sniper</p>
        <h1 className="display sect-h2">Eight real launches. Two seconds old each.</h1>
        <p className="sect-sub">Snipe or skip. No wallet, no money. Then it tells you what actually happened.</p>
        <div className="site-paper">
          <PaperSniper />
        </div>
      </section>
    </main>
  );
}
```

Then delete the old page:

```bash
git rm src/app/play/page.tsx
```

- [ ] **Step 3: Deal it on the landing page**

In `src/app/(site)/page.tsx`, add the import at the top:

```tsx
import PaperSniper from "./PaperSniper";
```

and, inside `<main className="site-main">`, after `<Hero … />`:

```tsx
      <section className="sect" id="paper">
        <p className="lab sect-lab">Paper sniper</p>
        <h2 className="display sect-h2">Eight real launches. Two seconds old each.</h2>
        <p className="sect-sub">
          Snipe or skip, with only what was knowable at the moment each one appeared. Then it
          tells you what actually happened, because this index holds the answer.
        </p>
        <div className="site-paper">
          <PaperSniper />
        </div>
      </section>
```

- [ ] **Step 4: Typecheck and play it**

Run: `npm run typecheck`
Expected: clean.

With `PUBLIC_MODE=1`, open `/`. Scroll to the paper sniper (or click the ghost button in the hero; expect the page to scroll to it). Play all eight rounds. Expected: the same rounds, reveals and verdict as the old `/play`, and three buttons at the end: Again, Draw the bow (lime), Open the terminal. Click Draw the bow: expect `/range` (still the old arcade at this point, so a 404 until Task 8 — that is expected; go back).

Open `/play`. Expected: the site nav, the heading, and the game.

- [ ] **Step 5: Commit**

```bash
git add -A src/app
git commit -m "The paper sniper is dealt on the front door, and on its own page" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The range window, the terminal section, the honest part

**Files:**
- Create: `src/app/(site)/RangeWindow.tsx`
- Create: `src/app/(site)/TerminalStrip.tsx`
- Create: `src/app/(site)/HonestNumbers.tsx`
- Modify: `src/app/(site)/page.tsx` (add the sections and the feed read)

**Interfaces:**
- Consumes: `readFeed`, `FeedRow` from `@/lib/feed/query`; `mediaUrl`, `fmtUsdish` from `@/lib/format`; `Butt` from `./Butt`.
- Produces: `RangeWindow({ hasPool: boolean })`, `TerminalStrip({ rows: FeedRow[] })`, `HonestNumbers()`.

- [ ] **Step 1: The range window**

Create `src/app/(site)/RangeWindow.tsx`:

```tsx
import Link from "next/link";
import Butt from "./Butt";

/**
 * A window onto the range, not the range.
 *
 * Three butts at three distances on the forest ground and one button. No
 * canvas, no three.js, no model on this page: a stranger on a phone gets a
 * poster and a door, and the scene loads only once they walk through it.
 */
export default function RangeWindow({ hasPool }: { hasPool: boolean }) {
  return (
    <section className="sect">
      <p className="lab sect-lab">Sherwood Shooting Range</p>
      <h2 className="display sect-h2">Real tickers on the butts.</h2>
      <div className="rwin">
        <Butt className="b1" />
        <Butt className="b2" />
        <Butt className="b3" />
        <div className="trees" aria-hidden="true" />
        <Link href="/range" className="btn btn-primary hbtn rwin-cta">
          Enter the range
        </Link>
      </div>
      <p className="rwin-cap">
        The ones down today shoot back.
        {hasPool && " Best run of the week takes the pool."}
      </p>
    </section>
  );
}
```

- [ ] **Step 2: The terminal strip**

Create `src/app/(site)/TerminalStrip.tsx`:

```tsx
import Link from "next/link";
import type { FeedRow } from "@/lib/feed/query";
import { fmtUsdish, mediaUrl } from "@/lib/format";

function age(min: number): string {
  if (min < 1) return "now";
  if (min < 60) return `${Math.floor(min)}m`;
  return `${Math.floor(min / 60)}h`;
}

/**
 * Three measured claims and the five newest launches, live.
 *
 * The numbers are the ones the README and the roadmap already make: they are
 * measured, not chosen for this page. The strip under them is the feed, read
 * on the server, so a stranger sees the thing the terminal does before being
 * asked to open it.
 */
export default function TerminalStrip({ rows }: { rows: FeedRow[] }) {
  return (
    <section className="sect">
      <p className="lab sect-lab">The terminal</p>
      <h2 className="display sect-h2">Every pons launch, the second it exists.</h2>
      <div className="claims">
        <div className="claim">
          <b className="display">0.09s</b>
          <span className="lab">from launch to indexed</span>
        </div>
        <div className="claim">
          <b className="display">0.2s</b>
          <span className="lab">candle resolution</span>
        </div>
        <div className="claim">
          <b className="display">before entry</b>
          <span className="lab">when the exit is set</span>
        </div>
      </div>
      {rows.length > 0 && (
        <div className="strip" aria-label="Newest launches">
          {rows.map((r) => (
            <div className="strip-row" key={r.token}>
              {r.logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={mediaUrl(r.logo)} alt="" decoding="async" />
              ) : (
                <span />
              )}
              <span className="sym">
                {r.symbol}
                <small>{r.name}</small>
              </span>
              <span className="q mono">{r.quoteSymbol}</span>
              <span className="age mono">{age(r.ageMinutes)}</span>
              <span className="mc num">{r.mcapUsd != null ? `$${fmtUsdish(r.mcapUsd)}` : "—"}</span>
            </div>
          ))}
        </div>
      )}
      <div>
        <Link href="/terminal" className="btn hbtn ghost">
          Open the terminal
        </Link>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: The honest part**

Create `src/app/(site)/HonestNumbers.tsx`:

```tsx
/**
 * Three figures from docs/FINDINGS.md, and one sentence.
 *
 * This follows the rule in docs/POSTS.md: it describes what the tool does and
 * never implies a return. If a number here changes, it changes in FINDINGS
 * first.
 */
export default function HonestNumbers() {
  return (
    <section className="sect">
      <p className="lab sect-lab">The honest part</p>
      <div className="honest">
        <div>
          <b className="display">~2%</b>
          <span>of launches ever graduate</span>
        </div>
        <div>
          <b className="display">−32%</b>
          <span>the median graduate, one hour after migration</span>
        </div>
        <div>
          <b className="display">0 of 9</b>
          <span>exit rules on which sniping every launch made money</span>
        </div>
      </div>
      <p className="sect-sub">
        This tool cannot change that. It can only make sure you exit on a rule rather than on a
        feeling.
      </p>
    </section>
  );
}
```

- [ ] **Step 4: Assemble the page**

In `src/app/(site)/page.tsx`, add imports:

```tsx
import { readFeed, type FeedRow } from "@/lib/feed/query";
import RangeWindow from "./RangeWindow";
import TerminalStrip from "./TerminalStrip";
import HonestNumbers from "./HonestNumbers";
```

Extend the `Promise.all` to read the feed:

```tsx
  const [board, pins, pool, feed] = await Promise.all([
    safely<Score[]>(() => top(3, week), []),
    safely<Pin[]>(async () => pickPins(await loadTargets()), []),
    safely<PoolInfo | null>(() => poolBalance(), null),
    safely<FeedRow[]>(async () => (await readFeed({ maxAgeMin: 180, limit: 5 })).rows, []),
  ]);
```

And render the full page:

```tsx
  return (
    <main className="site-main">
      <Hero pins={pins} board={board} endsAt={weekEnds(week)} pool={pool} />
      <section className="sect" id="paper">
        <p className="lab sect-lab">Paper sniper</p>
        <h2 className="display sect-h2">Eight real launches. Two seconds old each.</h2>
        <p className="sect-sub">
          Snipe or skip, with only what was knowable at the moment each one appeared. Then it
          tells you what actually happened, because this index holds the answer.
        </p>
        <div className="site-paper">
          <PaperSniper />
        </div>
      </section>
      <RangeWindow hasPool={pool !== null} />
      <TerminalStrip rows={feed} />
      <HonestNumbers />
    </main>
  );
```

- [ ] **Step 5: Typecheck and look at it**

Run: `npm run typecheck`
Expected: clean.

With `PUBLIC_MODE=1`, open `/` and scroll. Expected, in order: hero, paper sniper, the range window with three butts and a lime button, the three claims and a strip of five launches with logos, the three gold figures, the footer. Console clean.

To see one quiet state, set `DISABLE_PRICE_FEEDS=1` for a restart: the pins vanish and the butt stays. Unset it afterwards.

Resize to 375px. Expected: claims and figures stack, the strip hides quote and age columns, nothing scrolls horizontally.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(site)"
git commit -m "Below the hero: a window onto the range, the terminal's numbers, and the honest ones" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The range moves to `/range`, gets the site shell, and `/arcade` redirects

**Files:**
- Move: `src/app/arcade/page.tsx` → `src/app/(site)/range/page.tsx` (then edit)
- Move: `src/app/arcade/world.ts`, `sfx.ts`, `kit.ts` → `src/app/(site)/range/`
- Move: `src/app/arcade/sounds/page.tsx` → `src/app/(site)/range/sounds/page.tsx` (one import)
- Modify: `next.config.ts` (add `redirects()`)

**Interfaces:**
- Consumes: `Butt` from `../Butt`.
- Produces: routes `/range`, `/range/sounds`; permanent redirects from `/arcade`, `/arcade/sounds`.

- [ ] **Step 1: Read the redirects config doc**

Read `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/redirects.md`.

- [ ] **Step 2: Move the files**

```bash
git mv src/app/arcade/page.tsx "src/app/(site)/range/page.tsx"
git mv src/app/arcade/world.ts "src/app/(site)/range/world.ts"
git mv src/app/arcade/sfx.ts "src/app/(site)/range/sfx.ts"
git mv src/app/arcade/kit.ts "src/app/(site)/range/kit.ts"
git mv src/app/arcade/sounds/page.tsx "src/app/(site)/range/sounds/page.tsx"
```

Confirm `src/app/arcade/` is now empty and remove it if git left the folder behind.

- [ ] **Step 3: Fix the sound bench's one import**

In `src/app/(site)/range/sounds/page.tsx`, change:

```ts
import Logo from "../../Logo";
```

to:

```ts
import Logo from "@/app/Logo";
```

Nothing else in that file changes; `../sfx` still resolves.

- [ ] **Step 4: Reskin the range page's chrome**

In `src/app/(site)/range/page.tsx`:

Replace the imports

```tsx
import Link from "next/link";
import Logo from "../Logo";
```

with

```tsx
import Butt from "../Butt";
```

(`Link` is no longer used once the header goes; remove it to keep the typecheck clean.)

Replace the opening of the returned JSX, from `<main className="arc">` through the closing `</header>`:

```tsx
    <main className="arc">
      <header className="arc-top">
        <Link href="/" className="arc-home">
          <Logo size={26} />
          <span>Ponsnipe</span>
        </Link>
        <span className="arc-sub">
          Sherwood Shooting Range — real tickers on the butts, and the ones down
          today shoot back.
        </span>
      </header>
```

with

```tsx
    <main className="arc range">
      <div className="range-head">
        <Butt size={44} />
        <div>
          <h1 className="display">Sherwood Shooting Range</h1>
          <p>Real tickers on the butts, and the ones down today shoot back.</p>
        </div>
      </div>

      <div className="range-grid">
```

The start card stays as the overlay on the stage, because Start needs the canvas under it. The board moves beside the stage instead of below it. So: leave the whole `<div className={`arc-stage…`} ref={holder}> … </div>` block exactly as it is, then change the board section's opening tag from

```tsx
      <section className="arc-board">
```

to

```tsx
      <section className="arc-board" id="board">
```

and close the grid after the board section, before `</main>`:

```tsx
      </section>
      </div>
    </main>
```

- [ ] **Step 5: Add the redirects**

In `next.config.ts`, inside `nextConfig` before `async headers()`, add:

```ts
  /*
   * The arcade became the range when the site grew a front door. Permanent,
   * so anything that bookmarked or posted the old path keeps working.
   */
  async redirects() {
    return [
      { source: "/arcade", destination: "/range", permanent: true },
      { source: "/arcade/sounds", destination: "/range/sounds", permanent: true },
    ];
  },
```

- [ ] **Step 6: Typecheck, test, and play a round**

Run: `npm run typecheck && npm test`
Expected: clean and green (the arcade test does not import the page).

Restart the dev server (config changed) with `PUBLIC_MODE=1`. Open `/arcade`: expect a redirect to `/range`. Open `/range`: expect the site nav, the title with the small butt, the stage with the Start overlay on the left and the board on the right on a wide screen. Click Start and play a round: expect the game to behave exactly as before (aim, loose, scope on right-click, the HUD, the damage flash), the score to post, and the board to update. Open `/range/sounds`: expect the bench. Open `/range#board` from the nav's Board link: expect the page to land on the board.

Resize to 900px wide: expect the board to drop below the stage.

- [ ] **Step 7: Commit**

```bash
git add -A src/app next.config.ts
git commit -m "The arcade is the range now, with the site around it and the old path forwarding" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Final pass: phone, reduced motion, README, and the full check

**Files:**
- Modify: `README.md` (one paragraph in "Setup")
- Possibly modify: `src/app/(site)/site.css` (only if the phone pass finds a defect)

- [ ] **Step 1: The README**

In `README.md`, under "Setup", after the line `Then in the browser: **set up a wallet** → fund it → **Buy**.`, add:

```markdown
On a hosted instance (`PUBLIC_MODE=1`) the root is a landing page built around
the paper sniper and the range, and the terminal is at `/terminal`. On a local
install the root goes straight to the terminal, because there is nobody to
introduce it to.
```

- [ ] **Step 2: The phone pass**

With `PUBLIC_MODE=1`, at 375×812, open in turn `/`, `/play`, `/range`, `/terminal`. For each: no horizontal scroll (`document.documentElement.scrollWidth === window.innerWidth`), every button reachable, text legible, the nav collapsed to Range, Play, Terminal. On `/`, the pins are hidden and the butt is faint behind the headline. Fix any defect in `site.css` only.

- [ ] **Step 3: Reduced motion**

Emulate `prefers-reduced-motion: reduce` and reload `/`. Expected: pins and board rows appear without animation. Nothing else on the page animates.

- [ ] **Step 4: The full check**

Run: `npm run typecheck && npm test`
Expected: clean; all tests green, including the two new files.

Without `PUBLIC_MODE`, open `/`: expect `/terminal`. With it, open `/`, `/terminal`, `/play`, `/range`, `/range/sounds`, `/arcade` (→ `/range`), `/arcade/sounds` (→ `/range/sounds`). Expect each to render or forward as listed. Console clean on each.

Run `npm run build` once. Expected: the build completes, fonts are emitted under `.next/static/media`, and no request to a Google host appears in the build output. Do not commit `.next`.

- [ ] **Step 5: Commit**

```bash
git add README.md "src/app/(site)/site.css"
git commit -m "The front door, checked on a phone and written into the README" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review against the spec

- **Route groups, nested under the root layout:** Task 1 (terminal), Task 4 (site). The root layout is untouched.
- **`/` redirects locally, lands on the landing page hosted:** Task 1, kept through Task 5's rewrite.
- **`/terminal` moved unchanged, mark links home:** Task 1.
- **`/range`, `/range/sounds`, redirects from `/arcade*`:** Task 8.
- **`/play` renders the shared component:** Task 6.
- **Site nav (no Connect, Terminal button, Board → `/range#board`, collapses on phones):** Task 4; the `id="board"` anchor is Task 8.
- **Footer with conditional links and the fee wallet:** Task 4.
- **Fonts through `next/font`, CSP-legal:** Task 4, verified in Task 9's build.
- **Hero: label, headline, sentence, two buttons, pool line, butt, three pins from targets, board card:** Task 5.
- **Paper sniper inline, all eight rounds, verdict with two new buttons:** Task 6.
- **Range window as a CSS poster with a caption that drops its last sentence without a pool:** Task 7.
- **Terminal section: three claims, five-row strip, button:** Task 7.
- **Honest part: three figures and the sentence:** Task 7.
- **Palette tokens, three display sizes, one motif, grain on the hero only, motion with reduced-motion:** Task 4's stylesheet; Task 9 verifies.
- **Mobile: hero stacks at 720px, butt faint behind, strip truncates:** Task 4's media queries; Task 9 verifies.
- **`lib/targets.ts` lifted with the same cache and `DISABLE_PRICE_FEEDS`:** Task 3.
- **`lib/pool.ts`, cached 60s, null without a fee wallet, three decimals:** Task 2.
- **Quiet states:** `safely` in Task 5; the board's empty copy in Task 5; pins hidden when empty (Task 5 renders none); pool line, board footer and caption omitted when `pool` is null (Tasks 5 and 7); strip omitted when `rows` is empty (Task 7); paper rounds' existing "not enough launches" state with a retry (Task 6).
- **Tests: `tests/targets.test.ts`, `tests/pool.test.ts`, existing suite and typecheck green, browser checks on desktop and phone:** Tasks 2, 3, 9.
- **Deviation recorded:** the range page keeps its start card as the stage overlay (Start needs the canvas) and moves the board beside the stage; the spec's "side by side above the canvas" is met by the title row plus the two-column grid.
