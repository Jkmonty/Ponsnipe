# pons autotrade

Buy a token on [pons.family](https://ponsfamily.com), set your exit, walk away.

A local app for Robinhood Chain that watches your positions and sells them for
you — take-profit, stop-loss, trailing stop, and an exit before the token
graduates and the curve stops accepting sells. It runs on your machine, holds
its own wallet, and nothing is custodial to anyone else.

---

## Read this before you use it

**This has never executed a live trade.** Every price path, quote and contract
read is verified against the live chain, and the money-critical maths is
covered by 100 tests — but no transaction has ever been signed. Your first
live trade is also this code's first live trade. Start with an amount you
would shrug at losing.

**The sniper loses money.** Not a hedge — a measurement. Across 114,544 real
launches replayed through nine exit rules, automatic sniping was negative on
every single one, on both ETH-quoted and stock-quoted tokens. It ships disabled
and should stay that way unless you have a reason of your own. The numbers are
in [`docs/FINDINGS.md`](docs/FINDINGS.md).

**Most tokens here go to zero.** Around 2% of launches ever graduate. The
median token that *does* graduate is down 32% an hour later and 59% after
twelve. This tool cannot change that; it can only make sure you exit on a rule
rather than on a feeling.

**Your keys live on this machine**, encrypted with a passphrase you set. Anyone
with the keystore file and the passphrase has the funds. Do not put more in the
bot wallet than you are actively trading.

---

## What it does

- **Auto-sell** — take-profit, stop-loss, trailing stop, and a graduation exit.
  Once a token graduates its bonding curve stops accepting sells, so a winner
  that runs to the threshold would otherwise strand; the engine sells at 92% of
  the way there by default.
- **Sub-second exits** — re-prices on every new block and instantly on any trade
  against a curve you hold, applying the reserve change from the event itself
  with no extra round trip.
- **Launch composer** — drafts a ticker, name and description from a tweet, and
  checks them against 114,544 past launches so you know if a ticker has already
  been used and died.
- **Sniper** — auto-buys new launches through a filter chain. Off by default.
  See the warning above.

## Setup

```bash
npm install
npm run setup     # writes .env with a generated passphrase and API token
npm run dev       # http://127.0.0.1:3000
```

Then in the browser: **Create wallet** → fund it → **Buy**.

The app starts in **DRY-RUN**: it does everything except sign transactions, and
logs what it would have done. Leave it there until you have watched it decide
for a while. The toggle in the header switches to live.

### Optional

| variable | what it gives you |
|---|---|
| `RPC_URL` | A private endpoint (e.g. Alchemy). The public one is 1–3s behind, which is the difference between a 0.5s exit and a 3s one. |
| `WSS_URL` | WebSocket pushes rather than polling — measured 96ms between blocks against 570–1456ms polling. |
| `ANTHROPIC_API_KEY` | Lets the launch composer draft with Claude instead of a built-in heuristic. Costs a fraction of a penny per draft. |

## Research tools

The repo also contains the scanners used to test whether any of this is
tradeable. They are read-only and sign nothing.

```bash
npm run scan        # replay every launch through nine exit rules
npm run analyse     # dip patterns, deployer records, early-buyer signal
npm run bundles     # cluster wallets that are really one operator
npm run poolscan    # what happens after a token graduates
npm run clusters    # narrative waves: the same ticker minted repeatedly
```

Findings are written up in [`docs/FINDINGS.md`](docs/FINDINGS.md), including
the strategies that did not work and why — which is most of them.

## Tests

```bash
npm test
```

100 tests over the parts where a bug costs money: bonding-curve maths, exit
rules, the event fast path, the keystore, the double-sell guard, and CSRF on
the routes that move funds.

## Licence

Use at your own risk. Nothing here is financial advice, and the author of this
code has no idea whether any given token will go up.
