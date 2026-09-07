# Ponsnipe

Pick your shot on [pons.family](https://ponsfamily.com), loose it, walk away.

A local app for Robinhood Chain that watches your positions and sells them for
you — take-profit, stop-loss, trailing stop, and an exit before the token
graduates and the curve stops accepting sells. It runs on your machine, holds
its own wallet, and nothing is custodial to anyone else.

Named for the chain it trades on: Robin Hood took one careful shot at a time,
which is the opposite of how most people trade a memecoin launch.

---

## Read this before you use it

**This has never executed a live trade.** Every price path, quote and contract
read is verified against the live chain, and the money-critical maths is
covered by 115 tests — but no transaction has ever been signed. Your first
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
- **New-pairs feed** — every pons launch as it happens, newest first, with
  market cap, volume, liquidity, holder and trade counts, a twenty-minute price
  chart, and progress to graduation. Click one to load it into the buy form and
  jump straight to it, or press Ctrl/⌘-K and type a ticker or address. Volume
  and holders come from the curve trade events themselves rather than an
  estimate, and coins paired against tokenised equities are converted at the
  real share price.

  Launches arrive pushed over a WebSocket rather than polled — measured at 100%
  of launches captured and ~0.09s from launch to indexed — and are then pushed
  again from the server to the browser, so what you see is not waiting on a
  poll interval. If that connection fails the feed falls back to a ten-second
  check and says "polling" instead of "live".

- **Bundle detection** — how many of a coin's buyers are one operator wearing
  several wallets, clustered by funding graph. On a live sample, 29 of 250
  coins had a detectable bundle; one showed 5 bundled buyers against 6 holders.
  It is a floor, never a ceiling: wallets newer than the last `npm run bundles`
  scan are unknown and count as separate people. Needs `data/bundles.sqlite`;
  without it the column is simply absent.

- **Buy coins priced in anything** — about half of pons launches are quoted in
  USDG, NVDA, AAPL and other tokenised equities rather than ETH. Your ETH is
  swapped through the deepest Uniswap V3 pool for that asset first. Off by
  default for the sniper, because the hop costs a pool fee, a second
  transaction and a second chance to revert.

- **Snipe a ticker you know is coming** — name a ticker and it buys on sight,
  skipping the observation window and the crowd filters, but never the tax cap
  or your spend limits. Pin the maker's address: 27% of tickers on this chain
  have already been used more than once, and a ticker-only watch will very
  likely fire on a copy first.

## Setting up your wallet

Two options at first run. **Create a new one** is recommended: a fresh key that
has never touched anything else. **Use my own key** imports an existing private
key instead, for people who would rather not trust a key this app generated.

Either way the app holds a hot key — it has to, since the whole point is selling
while you are asleep and a browser wallet cannot sign then. Import a burner, not
a wallet you keep a balance in.

## Setup

```bash
npm install
npm run setup     # writes .env with a generated passphrase and API token
npm run dev       # http://127.0.0.1:3000
```

Then in the browser: **set up a wallet** → fund it → **Buy**.

The app starts in **DRY-RUN**: it does everything except sign transactions, and
logs what it would have done. Leave it there until you have watched it decide
for a while. The toggle in the header switches to live.

### Optional

| variable | what it gives you |
|---|---|
| `RPC_URL` | A private endpoint (e.g. Alchemy). The public one is 1–3s behind, which is the difference between a 0.5s exit and a 3s one. |
| `WSS_URL` | WebSocket pushes rather than polling — measured 96ms between blocks against 570–1456ms polling. |
| `LAUNCH_WS_URL` | The WebSocket that pushes new launches. Defaults to publicnode's, which is free and needs no key. Unset it and the polling sweep alone still captures everything, just ~1.7s later. |
| `LOGS_RPC_URL` | Pins log sweeps to one endpoint. Left unset they spread across every public endpoint for the chain, which is what stopped a single node's rate limit being the ceiling. |
| `FALLBACK_RPC_URL` | Where reads go when the primary refuses. Defaults to Robinhood's public endpoint, so a provider that hits its monthly quota costs you latency rather than a dead app. |
| `ETH_USD` | Pins the ETH price used for the feed's dollar figures. Left unset it is fetched from Coinbase's public endpoint every five minutes. |
| `BUNDLES_PATH` | Where the wallet-cluster database lives, for the bundle column. Defaults to `data/bundles.sqlite`, built by `npm run bundles`. |
| `REPUTATION_PATH` | Where the deployer/proven-buyer database lives. Defaults to `data/reputation.sqlite`, built by `npm run reputation`. |
| `DISABLE_PRICE_FEEDS` | Set to `1` to make no outbound calls except the RPC. The feed then shows amounts in each token's own quote asset rather than dollars. |
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
npm run bundles     # cluster wallets by funding graph -> data/bundles.sqlite
npm run reputation  # deployer records and proven buyers -> data/reputation.sqlite
```

The last two are not only research: the feed reads `bundles.sqlite` for its
bundle column, and the sniper reads `reputation.sqlite` for its deployer and
proven-buyer filters. Both are optional, and both degrade to "no data" rather
than to a wrong answer.

Findings are written up in [`docs/FINDINGS.md`](docs/FINDINGS.md), including
the strategies that did not work and why — which is most of them.

## Tests

```bash
npm test
```

115 tests over the parts where a bug costs money: bonding-curve maths, exit
rules, the event fast path, the keystore, the double-sell guard, and CSRF on
the routes that move funds.

## Sharing this with other people

### What a link actually gives them

A GitHub URL hands someone the **source code**, not a running app. They will
need Node installed and will have to run four commands before they see
anything. That is a real barrier — expect most people who click it to stop
there — and it is also the whole reason this is safe to hand out: they run it,
they hold their own keys, and nothing of theirs passes through you.

A link people can simply click and use would mean hosting it, and hosting it
means one wallet shared by everyone or you holding theirs. That is custody,
which is a regulated activity in most places and a different project from this
one. There is no free tier that makes that problem smaller.

### Publishing the repo

Nothing secret is tracked — `.env`, `data/` (the keystore and every database)
and any `*.sqlite` are all ignored, and none has ever been committed. Verify
that for yourself before you push, because it cannot be undone afterwards:

```bash
# Both must print nothing. The pattern deliberately matches .env, any
# *.keystore.json, any *.sqlite and everything under data/ — while ignoring
# .env.example and src/lib/wallet/keystore.ts, which are source and belong here.
PAT='(^|/)\.env($|\.)|\.keystore\.json$|\.sqlite$|^data/'
git ls-files | grep -E "$PAT" | grep -v '^\.env\.example$'
git log --all --diff-filter=A --name-only --pretty=format: | sort -u   | grep -E "$PAT" | grep -v '^\.env\.example$'
```

Then create an empty repository on GitHub and push to it. The URL of that
repository is what you share.

### What to tell them

> Needs [Node](https://nodejs.org) 22.5 or newer. Then:
>
> ```bash
> git clone <your repo url>
> cd ponsnipe
> npm install
> npm run setup     # writes .env with a generated passphrase and API token
> npm run dev       # http://127.0.0.1:3000
> ```
>
> It starts in DRY-RUN and the sniper starts disabled. Read the warnings at
> the top of this file before turning either off.

The feed, the charts, the bundle column and looking up any token all work with
no wallet and no funds, so someone can run it and see whether they like it
before going anywhere near a private key.

## Running an always-on instance

Only two reasons to bother: your own sniper running while you sleep, or a
read-only shop window for the repo. Either way it needs a **persistent** host,
not a serverless one.

At boot `src/instrumentation.ts` starts four long-lived things — the position
monitor, the sniper's chain watcher, the feed sweep and a WebSocket launch
stream — and the app writes SQLite to local disk and holds SSE connections
open. Vercel, Netlify and the other serverless free tiers cannot run any of
that: functions do not persist between invocations, the filesystem is
read-only apart from an ephemeral `/tmp`, and long-lived connections are cut.
The background indexer is the product, and it is the first thing that dies.

What does work is anything that runs a normal Node process with a disk —
Fly.io, an Oracle Cloud Always Free VM, a cheap VPS, or the machine already in
front of you. Avoid free tiers that **sleep on inactivity**: sleeping stops
the sweep and empties the price history, so you wake up to an app with no
memory. Free-tier terms change often, so check the current ones rather than
trusting this paragraph.

```bash
npm run build
npm start          # 127.0.0.1:3000 — this machine only
```

Note what that does NOT do. `npm start` binds to `127.0.0.1`, so it is
unreachable from anywhere else, and that default is deliberate: an app holding
a hot private key should not listen to the whole internet because someone
typed `npm start`. To actually serve an instance you have to say so:

```bash
npx next start -H 0.0.0.0 -p 3000
```

Do that only behind something that terminates TLS, and only with
`ENGINE_API_TOKEN` set — it is the single thing standing between a stranger
and the endpoints that move funds.

For a public read-only instance, leave the wallet unconfigured and the sniper
off. Everything that spends money is behind the bot wallet, so an instance
without one can show the feed and price nothing else. Do not expose an
instance that has a funded keystore: `ENGINE_API_TOKEN` is the only thing
standing between a stranger and your trading endpoints.

## Licence

Use at your own risk. Nothing here is financial advice, and the author of this
code has no idea whether any given token will go up.
