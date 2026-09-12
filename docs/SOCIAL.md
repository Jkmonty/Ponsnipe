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
| `pfp.png` | 400×400 | Profile picture, dark |
| `banner.png` | 1500×500 | Header, dark |
| `pfp-white.png` | 400×400 | Profile picture, light |
| `banner-white.png` | 1500×500 | Header, light |

Use one set or the other. A dark profile picture against a light header reads
as two brands, which is the only way to get this wrong.

The dark set holds up better at timeline size: X renders a profile picture at
about 48px against its own white chrome, and the light version puts a pale
mark on a pale background at exactly the size where contrast matters most.

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

**Bio** (160 characters). X keeps line breaks, so the strongest shape is a
punch followed by the substance.

**The one I would use:**

> Name the ticker. We buy it the second it exists.
> Every pons launch. Candles to 0.2s. Exits set before entry.

*(105. The first line is the thing no competitor can say — arming a buy on a
coin that does not exist yet. The second earns it.)*

Others, if that is not the voice:

> Arm a snipe on a coin that doesn't exist yet.
> Every pons launch, the second it lands.

*(84. Shorter, stranger, more memorable. Leads entirely on the one capability
nobody else has.)*

> You can't click fast enough.
> Snipe pons launches by ticker. Exits set before you're in.

*(86. Leads on the reader rather than the product. The most human of the
three, and the one that works on somebody who has already been beaten to a
launch.)*

> Every new pons coin, the second it exists. Snipe by ticker before it
> launches. Set the exit before the entry.

*(118. The plainest. Three claims, no rhetoric — right if the audience is
suspicious of marketing.)*

**Avoid** anything with "fastest", "best" or "#1" in it. Every bot account on
this timeline says those, so they read as noise, and the first of them is a
claim somebody will test.

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
