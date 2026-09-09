# What to build next

Researched September 2026 against Axiom, Photon, GMGN, Trojan, BullX, BONKbot
and Banana Gun, then checked against what this codebase already indexes.

The organising question is not "what do they have that we do not" — that list
is long and most of it does not matter. It is "what do we already have the data
for", because on this chain we index the whole trade stream ourselves, and that
turns several of their headline features into a weekend of UI rather than a new
data pipeline.

---

## Where we are already ahead

Worth writing down, because it is easy to build toward competitors and lose the
things that are actually ours.

**Per-trade prices.** Every other terminal samples the price on an interval and
draws a line through it. We record the price after every individual buy and
sell, which is why the chart goes to 0.2s and why the wicks are real. Nobody is
beating this without doing the same indexing work.

**We compute our own risk numbers.** Holder counts, sniper counts, bundled
wallets, dev holdings, top-10 concentration, dev launch history — all derived
from the trade stream, not bought from an API. Most terminals resell somebody
else's numbers and inherit their gaps.

**Pre-launch sniping by ticker.** Arming a buy against a coin that does not
exist yet. Axiom's nearest equivalent is a migration sniper, which fires on a
token that is already trading.

**We are the only terminal on this chain.** That is a moat until it is not.

---

## The one real structural gap

**Auto-sell only runs while the tab is open.**

Every competitor executes take-profit and stop-loss server-side, 24 hours a
day. Ours runs in the browser, which means closing the laptop disarms it. The
code is honest about this — `useAutoSell.ts` exists partly to make sure the
limit is never overstated — but honesty does not make it competitive.

There is a server engine already (`src/lib/sniper/engine.ts`) that does exactly
this. It is operator-only because it needs a key that can sign unattended.

Three ways forward, in increasing order of what they ask of the user:

1. **Leave it.** Say plainly that rules need the tab open, and lean on the
   browser-only story: we cannot touch your money because we never hold it.
   That is a real selling point to a certain kind of trader.
2. **Session keys.** A key delegated to the server with a spend cap and an
   expiry, revocable from the UI. The user decides how much exposure to hand
   over and for how long. More work, and the security design has to be right
   before a line of it ships.
3. **Full custody.** What the Telegram bots do. Fastest to build, and it makes
   us responsible for other people's money. I would not.

This is a decision about what kind of product this is, not a ticket. It should
be made deliberately.

---

## The cheapest big win: wallet tracking

Axiom's headline feature is a wallet tracker — they advertise following up to
10,000 wallets — and copy trading built on top of it. Photon and GMGN sell the
same thing.

**We already have the data.** `feed_positions` holds a running net balance per
wallet per curve, plus the block of each wallet's first buy. Measured on the
live server, inside a three-hour window:

- **5,028** distinct wallets tracked
- **21,287** position rows across **2,276** tokens
- **1,827** distinct deployers
- the busiest wallet had touched **1,216** curves

Nothing new needs indexing. What it needs is retention (the table is pruned
with the feed window, so history stops at three hours) and a screen.

What it unlocks, roughly in order of value per unit of work:

- **"Who else is in this?"** on the coin you are looking at — how many snipers,
  how concentrated, whether the wallets holding it are ones that have been
  right before.
- **Dev wallet history.** Every previous launch by this deployer and how each
  one ended. We already show a count; the histories are sitting there. This is
  the single most predictive thing a trader can look at before buying.
- **Smart money.** Wallets ranked by how their launches actually went. We can
  compute this because we have both the positions and the price history.
- **Follow a wallet.** Alert, or arm a snipe, when a named wallet buys.

One honest limit to carry into the UI: positions are built from curve trades
only. A wallet-to-wallet transfer moves tokens without either event, so these
are lower bounds rather than a chain-wide balance scan. Rare before graduation,
but it must be said rather than discovered.

---

## Exit tools we are missing

Small, well-understood, and they fit the code that already exists.

**Trailing stop.** We have a fixed stop. A trailing one — "sell if it falls 20%
from its high" — is the single most requested exit tool in every comparison
article, and `useAutoSell.ts` already ticks on an interval with the price in
hand. It needs a high-water mark per position and nothing else.

**Laddered exits.** Sell 25% at 2x, 25% at 5x, let the rest run. We already do
partial take-profit with a configurable share; this is that, as a list instead
of a single rule.

**Limit buy.** Arm a buy that fires if the price comes back to a level. The
sniper already watches and fires on a condition; the condition is just a
different one.

---

## Growth and money

Not features exactly, but they decide whether any of this matters.

**A shareable P&L card.** An image with the coin, the multiple and the numbers.
This is how the Telegram bots grew — every winning trade becomes an
advertisement posted by the person who made it. Cheap to build, and the only
item on this page with a viral loop attached.

**Fees.** The going rate is 0.7% to 1% per trade (BONKbot 1%, AveSniper 0.8%,
ReaperSniper 0.7%), usually with a referral share of 10-30% paid back to the
referrer. If Ponsnipe is ever going to pay for itself this is the mechanism the
market already accepts, and it is easier to introduce early than to add later.

**Mobile.** Trojan's whole pitch is trading from a phone. A responsive layout
is a long way short of that, but it is also a long way short of the work.

---

## Ideas nobody else can copy

These come from the chain rather than from the competition, and they are the
most defensible things on this page.

**Stock-denominated P&L.** Over half of pons coins are priced in tokenised
stocks — NVDA, SPY, SPCX. That means a position can be up in its quote asset
and down in dollars, and every other terminal would report only one of those.
"Up 40% in NVDA, which is down 3%, so up 36% in dollars" is a sentence only we
can write.

**Same ticker, different quote.** Tickers get reused constantly — 82% of pons
tickers have been used before. Showing every live coin sharing a ticker, and
what each is priced against, is both a safety feature and a trading one.

**Market-hours behaviour.** Do coins priced against NVDA move differently when
the US market is open? We have the launches, the prices and the timestamps to
answer that. If the answer is yes it is a genuine edge; if it is no, it is one
honest sentence on the site that nobody else has earned the right to write.

---

## Deliberately not building

**Contract safety scores.** Honeypot checks, mint authority, LP burn. We do not
analyse contracts, so we do not have a box for it, and a tick that can never
fail is worse than a missing one — it tells a trader something was checked when
nothing was. This stays off the screen until we actually do the analysis. The
filter panel says so out loud.

**Automatic copy trading.** Tracking wallets is useful. Automatically mirroring
them is a good way to inherit someone else's exit at a worse price. If it is
built at all it should arm a snipe for the user to confirm, not fire on its
own.

**MEV protection**, until somebody checks whether this chain has a public
mempool worth protecting against. Every comparison article lists it because
Solana and Ethereum need it. Assuming it transfers here would be copying a
feature rather than solving a problem.

---

## If I had to pick three

1. **Trailing stop and laddered exits.** Days, not weeks. Fits the existing
   auto-sell loop. Closes the most-cited gap in the exit tooling.
2. **Dev wallet history.** The data is indexed, the count is already on screen,
   and it is the most predictive thing a memecoin trader can see before buying.
3. **Decide the server-side execution question.** Not build it — decide it. It
   shapes the product, and everything else is easier to plan once it is settled.

---

## Sources

- [Top 7 Solana Sniper Bots in 2026 — RPC Fast](https://rpcfast.com/blog/top-solana-sniper-bot)
- [Leading Solana Sniper Bots in 2026 — Dysnix](https://dysnix.com/blog/top-solana-sniper-bot)
- [Best Solana Memecoin Bot 2026 — Parasol](https://parasol.so/blog/best-solana-memecoin-bot-2026)
- [Axiom Trade Review 2026 — Coin Bureau](https://coinbureau.com/review/axiom-trade-review)
- [Axiom: Sniper, Copy Trade, Twitter and Wallet Tracker](https://medium.com/@blog_crypto/axiom-solana-trading-bot-sniper-copy-trade-twitter-and-wallet-tracker-dfd25fb94d29)
- [Auto Trading: Quick Buy, Take-Profit / Stop-Loss — GMGN docs](https://docs.gmgn.ai/index/auto-trading-quick-buy-take-profit-stop-loss)
- [Photon Tutorial 2026 — DEXTools](https://www.dextools.io/tutorials/how-to-use-photon-trading-bot-solana-tutorial-2026)
- [Top 10 Memecoin Trading Terminals in 2026 — QuickNode](https://www.quicknode.com/builders-guide/best/top-10-memecoin-terminals)
- [Memecoin Trading Tools: The Complete 2026 Guide — Definitive](https://www.definitive.fi/blog/memecoin-trading-tools-guide)
- [Trading Fee & Referral Rewards — Ave Sniper Bot](https://avebotdoc.ave.ai/en/faq/trading-fee-and-referral-rewards)
- [Telegram Trading Bot Referral Programs — CoinCodeCap](https://coincodecap.com/all-telegram-trading-bot-referral-programs-listed)
