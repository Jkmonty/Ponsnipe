# The X account

Everything needed to set up @ponsnipe, in the order the form asks for it.
Posts live in [POSTS.md](POSTS.md); this is the profile itself.

---

## Images

Both generated from the supplied artwork and sitting in
`public/brand/social/`. They use the site's own background (`#06070a`), so the
profile reads as the same object as the product rather than as a logo floating
on white.

| File | Size | Where |
|---|---|---|
| `pfp.png` | 400×400 | Profile picture |
| `banner.png` | 1500×500 | Header |

The mark is centred with a wide margin because X crops the profile picture to
a circle — anything near the corners is lost. The banner keeps the lockup
centred and above the midline for the same reason in reverse: the profile
picture overlaps the lower left, and the sides crop on a phone.

---

## Fields

**Name:** `Ponsnipe`

**Handle:** `@ponsnipe` if it is free. If not, in order of preference:
`@ponsnipeapp`, `@getponsnipe`, `@ponsnipe_`. Avoid anything with a number in
it — it reads as the impersonation account rather than the real one.

**Website:** `https://ponsnipe.com`

**Location:** `Robinhood Chain` — the field is free text, and it says what
chain this is for to anybody skimming.

**Bio** (160 characters). Three that say different things:

> Every new pons coin, the second it exists. Snipe by ticker before it
> launches. Set the exit before the entry.

*(118 — the default. Leads with the feed, which is what people can use without
connecting anything.)*

> The pons terminal. Every launch as it lands, candles down to 0.2s, and a
> sniper you arm before the coin exists.

*(114 — leads with the product category. Better if the audience already knows
what a terminal is.)*

> Snipe pons launches by ticker. Take-profit and stop-loss set before you buy,
> so the exit isn't a decision you make while shaking.

*(133 — leads with the emotional argument, which is the strongest one we have
and the one no competitor makes.)*

---

## The pinned post

Pin something that works for somebody who has never heard of pons. This is the
first thing on the profile and it stays there:

> pons launches a new coin every few seconds.
>
> By the time you have found one, read it and decided, it is over.
>
> Ponsnipe watches all of them for you.
>
> ponsnipe.com

Post it, then pin it. Do not pin a "we are live" post — those age badly within
a week and then the top of the profile is a stale announcement.

---

## Before the first post

**Check the site on a phone.** Most of the traffic from X is mobile, and the
first thing anybody does is tap the link. A layout problem there costs more
than a good post gains.

**Do not deploy in the five minutes before posting.** A restart clears the
image cache and the feed looks thin for a few minutes while it refills.

**Have the first three or four posts ready** rather than posting one and
waiting. An account with a single post reads as abandoned.

---

## What is actually true today

Worth keeping straight, so nothing on the account claims more than the product
does:

- The feed, filters and candles work for anybody, with no wallet connected
- Sniping by ticker before launch works, in the visitor's own browser
- Take-profit, stop-loss and partial take-profit work **while the tab is open**
  — this is a real limit and the UI says so; the account should not imply
  otherwise
- There is no mobile app, no Telegram bot, and no server-side execution
- Deploy, alerts and stock-denominated P&L are on the roadmap, not shipped
