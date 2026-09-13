# The front door

*Design spec, 13 September 2026. Brainstormed with three hero mockups and
three page-structure wireframes; the chosen ones are described here rather
than attached, since the mockups live in `.superpowers/brainstorm/` and are
not committed.*

## What this is

A landing page at the root of ponsnipe.com for a stranger who has never seen
the product, built around the two things a stranger can use without a wallet:
the paper sniper and the Sherwood Shooting Range. The trading terminal moves to
its own route and is otherwise untouched.

The direction is **Sherwood at night**: forest black, gold as firelight, lime
as the bowstring, a serif with weight for headlines, and one motif, the archery
butt, carrying real data. The weekly board sits in the hero.

The structure is **play on the page**: the paper sniper is dealt inline, all
eight rounds, and the range is a window you enter rather than a scene that
runs behind the copy.

## Decisions already made

These came out of the brainstorm and are not open.

| Question | Answer |
|---|---|
| What is "the site"? | A public front door, with the games as the showpiece. The terminal stays as it is. |
| First action for a stranger | Play. Trading is discovered afterwards. |
| Visual direction | A, Sherwood at night, with B's board kept in the hero. |
| Below the hero | Structure 1: paper sniper inline, range as a window, terminal, honest numbers, footer. |
| How much paper sniper on the landing | All eight rounds, verdict included. |
| Build approach | Route groups. One token set, a separate site stylesheet. Terminal CSS untouched. |

## Non-goals

- No change to the terminal beyond moving its route and linking its mark to
  the root.
- No live 3D scene on the landing page. The range window is a poster. A
  desktop attract mode is a possible later phase.
- No new board route. The hero shows the top three; the full table stays on
  the range page.
- No Connect button in the site nav. The mockup showed one; the landing page
  has nothing for a wallet to do. The nav's action is the terminal.
- No wallet tracking, share cards, or anything else from the roadmap.

## Architecture

### Route groups

One root layout stays where it is (`src/app/layout.tsx`: html, body,
`globals.css`). Two nested groups sit under it. Nested, not root, so moving
between the site and the terminal is a client navigation and not a full
reload, and so the root-layout caveats in the route-group docs do not apply.

```
src/app/
  layout.tsx                    root: html/body, globals.css   (unchanged)
  globals.css                   tokens + terminal styles       (unchanged)
  Dashboard.tsx, Feed.tsx, …    terminal components            (unchanged, stay put)

  (site)/
    layout.tsx                  site nav, footer, fonts, site.css
    site.css                    the Sherwood layer
    page.tsx                    the landing page  →  /
    SiteNav.tsx  SiteFooter.tsx
    Hero.tsx  Butt.tsx  BoardCard.tsx
    PaperSniper.tsx             lifted out of play/page.tsx
    RangeWindow.tsx  TerminalStrip.tsx  HonestNumbers.tsx
    play/page.tsx               →  /play        (site layout + PaperSniper)
    range/page.tsx              →  /range       (moved from arcade/)
    range/world.ts  sfx.ts  kit.ts               (moved, unchanged)
    range/sounds/page.tsx       →  /range/sounds

  (terminal)/
    terminal/page.tsx           →  /terminal    (the old src/app/page.tsx)

src/lib/
  targets.ts                    quote + cache, lifted out of api/arcade/targets
  pool.ts                       fee-wallet balance, cached
```

`src/app/page.tsx` and `src/app/arcade/` are removed. The API routes do not
move.

### Routes

| Path | What | Notes |
|---|---|---|
| `/` | Landing page | Server component. When `env.publicMode` is false, calls `redirect("/terminal")` before rendering anything: a local install has no stranger, and `npm run dev` must still open the tool. |
| `/terminal` | The dashboard | The old root page, moved. Its mark links to `/`. |
| `/range` | Sherwood Shooting Range | Renamed from `/arcade`. |
| `/range/sounds` | The sound bench | Moved with it. |
| `/play` | Paper sniper, standalone | Renders the shared `PaperSniper` component. |
| `/arcade`, `/arcade/sounds` | Redirect | Permanent redirects to the `/range` equivalents, in `next.config.ts` `redirects()`. |

Links inside the app that point at `/arcade` or `/play` are updated. The
README's "http://127.0.0.1:3000" instruction still holds because of the local
redirect.

### The site layout

`(site)/layout.tsx` renders the nav, the page, and the footer, and attaches
the fonts as CSS variables on its wrapper.

**Nav.** Mark and wordmark (the supplied artwork, as the terminal already
does), then links: Range, Paper sniper, Board, Terminal. Board goes to
`/range#board`. Terminal is the only button-styled item. On narrow screens the
links collapse to Range, Play, Terminal.

**Footer.** One line, mono: X, Source (only when `NEXT_PUBLIC_REPO_URL` is
set, as the terminal already does), the fee wallet address linked to the
explorer (only when a fee wallet is configured), and "Run your own" to the
repo.

**Fonts.** Fraunces (display) and JetBrains Mono (numbers, labels), through
`next/font/google`, which downloads at build time and serves from this origin.
That is what makes them legal under the production CSP's `font-src 'self'`.
If the container build ever runs without network, the fallback is
`next/font/local` with the same two families committed under
`(site)/fonts/`; nothing else changes. Body text stays the system sans the
terminal uses.

## The landing page

Six sections. Every section is either playable or measured.

### 1. Hero

Two columns on desktop; on phones the copy, then the board card, with the butt
cropped behind the headline at low opacity.

**Left.**
- Label, mono, gold: `SHERWOOD · ROBINHOOD CHAIN`.
- Headline, Fraunces: *Pick your shot. Loose it. Walk away.* "Loose it." in
  italic gold.
- One sentence: *Every pons launch, the second it exists. Exits set before
  you're in. And a range where today's tickers are the targets.*
- Buttons: **Draw the bow** (lime) to `/range`; **Paper sniper · 8 real
  launches** (ghost) scrolls to section 2.
- Pool line, mono, only when a fee wallet is configured: *This week's pool
  0.412 ETH · paid from an address anyone can check*, the amount in gold, the
  sentence linking to the explorer.

**Right.**
- **The butt.** Concentric rings in CSS: gold centre, red, blue, dark green,
  cream. Slightly rotated, a soft gold glow behind it, one drawn arrow
  entering from the left.
- **Three pins** on the rings, mono chips: a share ticker and its day move,
  green when up and red when down. These are the range's targets, from
  `lib/targets.ts`, the top three by how many live launches are priced
  against them. Rendered on the server so they are in the first paint.
- **The board card**, the same surface and hairline the terminal uses: header
  *This week* and *ends Mon 00:00 UTC* in gold; rows 01, 02, 03 with a short
  wallet or name and points in lime mono, the first rank number in gold;
  footer with the pool amount and the fee address, both linking out. From
  `lib/arcade` `top(3)`, `weekOf`, `weekEnds`.

**Ground.** Forest-black radial gradient, a grain overlay at low opacity on
this section only, and a tree-line silhouette along the bottom edge drawn
with layered gradients. No images.

### 2. Paper sniper

The existing game, unchanged in rules and copy, moved into `PaperSniper.tsx`
and rendered here in full: eight real launches from `/api/paper`, snipe or
skip, then the verdict with which single rule would have skipped most of the
losers. The component is client-side and fetches on mount, as the current
page does.

Section label: *Eight real launches. Two seconds old each. Snipe or skip.*

The verdict card gains two buttons at the end: **Draw the bow** to `/range`
and **Open the terminal** to `/terminal`. `/play` renders the same component
inside the site layout with the same label.

### 3. The range window

A wide panel drawn in CSS: three butts at three distances on the forest
ground, the tree line, and one button centred over it: **Enter the range**
to `/range`. A caption underneath: *Real tickers on the butts. The ones down
today shoot back. Best run of the week takes the pool.* The last sentence is
omitted when no fee wallet is configured.

No canvas, no three.js, no model on this page.

### 4. The terminal

Three claims with their numbers in Fraunces, captions in mono:

| Number | Caption | Source |
|---|---|---|
| 0.09s | from launch to indexed | README, measured |
| 0.2s | candle resolution | roadmap, per-trade prices |
| before entry | when the exit is set | the auto-sell feature |

Under them, `TerminalStrip.tsx`: the five newest launches from the feed query
that `/api/feed` uses, called directly on the server: logo, ticker, quote
asset, age, market cap in dollars. Then **Open the terminal**.

### 5. The honest part

Three figures, Fraunces in gold, from `docs/FINDINGS.md`:

| Number | Caption |
|---|---|
| ~2% | of launches ever graduate |
| −32% | the median graduate, one hour after migration |
| 0 of 9 | exit rules on which sniping every launch made money |

One sentence under them: *This tool cannot change that. It can only make sure
you exit on a rule rather than on a feeling.* This section follows the rule in
`docs/POSTS.md`: it describes what the tool does and never implies a return.

### 6. Footer

As described under the site layout.

## The visual system

Everything below lives in `site.css`, scoped under the site layout's wrapper
class, so no rule reaches the terminal.

**Palette.** The existing tokens are the base: `--lime`, `--gold`, `--up`,
`--down`, the four text levels, the spacing steps, the radii. The site layer
adds:

| Token | Value | Role |
|---|---|---|
| `--forest-0` | `#070b08` | page ground |
| `--forest-1` | `#0d140f` | panels on the ground |
| `--forest-2` | `#121b15` | raised: rows, headers |
| `--moon` | `#e9efe6` | primary text on forest |
| `--moss` | `#aeb9ab` | secondary text |
| `--bark` | `#6f7d6c` | tertiary text, labels |

Colour keeps its meaning. Lime is "you can act on this": the primary button,
board points, focus rings. Gold is the brand, the pool, the highlighted word
in the headline, and the honest numbers. Green and red are money and day moves
and nothing else.

**Type.** Three display sizes: hero headline, section headline, and the big
numbers. Fraunces at weight 700, optical size 144, tight letter-spacing,
line-height under 1. Nothing else is in the serif. Body copy is the system
sans at 15px to 18px. Every number, label, address and caption is JetBrains
Mono with tabular numerals, uppercase labels at 11px with wide tracking.

**The one motif.** `Butt.tsx` draws the target once and is used three times:
the hero (large, with pins), the range window (three, at distance), and the
range page's title mark (small). No parchment, no woodcut borders, no serif
next to a number, no second motif.

**Texture and motion.** Grain on the hero ground only. On load the pins settle
onto the butt and the board rows fade in, 180ms, the same curve the terminal
uses. Everything honours `prefers-reduced-motion`. Nothing animates behind
text.

**Layout.** Content column at 1180px. The hero is a two-column grid that
stacks at 720px. Cards and panels use the terminal's radii. Nothing scrolls
horizontally at any width; the terminal strip truncates rather than overflows.

## The range and paper sniper pages

**`/range`** takes the site nav and footer, a Fraunces title with the small
butt beside it, and the start card and the full board side by side above the
canvas, in the forest palette. The canvas, `world.ts`, `sfx.ts`, `kit.ts`, the
scope overlay, the HUD and the damage flash are moved and not changed. The
board section gets `id="board"` so the nav link lands on it.

**`/play`** is the site layout, the section label, and `PaperSniper`.

## Data

| Section | Source | Where it runs |
|---|---|---|
| Pins | `lib/targets.ts` | server, at request time |
| Board | `lib/arcade` `top(3)` | server |
| Pool | `lib/pool.ts` | server, cached 60s |
| Terminal strip | the feed query behind `/api/feed`, limit 5 | server |
| Paper rounds | `/api/paper` | client, on mount |

The landing page is `dynamic = "force-dynamic"`, as the terminal is.

**`lib/targets.ts`** is the quote-and-cache logic currently inside
`api/arcade/targets/route.ts`, lifted out so a server component can call it.
The route becomes a thin wrapper. Behaviour is unchanged, including the
two-minute cache and the `DISABLE_PRICE_FEEDS` switch.

**`lib/pool.ts`** reads the fee wallet's balance with the existing chain
client and caches it in module scope for sixty seconds. It returns `null`
when `NEXT_PUBLIC_FEE_WALLET` is unset or not an address. The amount is shown
to three decimals.

## Failure

Every live section degrades to a quiet state. The page never blocks on a
network call and never shows a spinner where a number should be.

| If | Then |
|---|---|
| No scores this week | The board card says *Nobody has posted a score yet.* |
| Targets unavailable | The pins are not rendered. The butt and arrow stay. |
| Pool unavailable or no fee wallet | The pool line, the board footer's amount, and the range caption's last sentence are omitted. |
| Feed unavailable | The terminal strip is omitted. The three claims and the button stay. |
| Paper rounds unavailable | The card shows the existing "could not deal" state with a retry, as `/play` does today. |

## Testing

The repo's pattern: `node --test` over pure functions, no component test
runner.

- `tests/targets.test.ts`: pin selection takes the top three by launches,
  sorts them, and classifies the day move; an empty list yields no pins.
- `tests/pool.test.ts`: formatting to three decimals, and `null` for an unset
  or malformed fee wallet.
- The existing 115 tests and `npm run typecheck` stay green.
- Layout is verified in the browser before completion: desktop and a 375px
  phone, the landing, `/range`, `/play`, `/terminal`, and both redirects.

## Later, not now

- A desktop attract mode: the live scene behind the hero on wide screens.
- A share card for a run on the range.
- The terminal picking up the site nav.
