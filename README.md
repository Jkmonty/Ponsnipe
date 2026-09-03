# pons autotrade

Buy [pons.family](https://www.ponsfamily.com) memecoins on **Robinhood Chain** (chain 4663)
and have them **sell automatically** when your PnL hits a take‑profit or stop‑loss target —
so the exit isn't an emotional decision made at 2am.

> ⚠️ This trades real money on a permissionless launchpad. Memecoins routinely go to
> zero. Start in dry‑run, test with dust, and only risk what you can lose.

---

## How it works

pons v2 launches every token onto its own **constant‑product bonding curve** contract.
You trade by calling `buy()` / `sell()` on that curve until the token graduates
(~4.2 ETH raised) into a locked Uniswap v4 pool.

- **Buy** – the app calls `curve.buy{value: eth}(quoteIn, minTokensOut, you)` from your
  bot wallet and records the entry price.
- **Watch** – an in‑process, **event‑driven monitor**: it re‑prices every open position
  on every new block *and* the instant any buy/sell hits your token's curve (whichever is
  sooner), with a heartbeat sweep as a safety net. All open positions are priced in one
  `multicall` per pass.
- **Auto‑sell** – when unrealised PnL crosses your `takeProfit` / `stopLoss` /
  `trailingStop`, it calls `curve.sell()` immediately. No clicks, no tab required.

**Reaction speed is capped by your RPC.** The public Robinhood Chain RPC serves stale state
(~1–3 s between updates) and has no WebSocket, so exits lag by that much. Point `RPC_URL` at
a private endpoint (Alchemy etc.) and reaction drops to roughly one block. The UI shows the
measured RPC lag and warns when it's slow.

The bot wallet's private key is stored **AES‑256‑GCM encrypted** in
`data/bot.keystore.json`, unlocked by `KEYSTORE_PASSPHRASE`. Nothing is custodial to
anyone but you.

### Sniper

Watches the pons v2 factory for `TokenLaunched`, waits `delaySeconds` (default 20 — past
the ~99%→0 anti‑snipe‑tax window), then buys launches that pass your filters and hands the
position straight to the auto‑sell monitor with your default targets.

Filters: min/max liquidity, max creator tax, min "other buys" during the delay, deployer
allow/deny lists, symbol/name regex. Safety caps: max concurrent snipes, max snipes/hour,
max daily spend. Everything is editable in the UI (**Sniper** card) and stored in
`data/sniper.json`. It only buys when the LIVE switch is on — otherwise it logs
"would snipe".

### Not handled yet
- **Post‑graduation tokens.** Selling in a Uniswap v4 pool isn't wired up. If a position
  graduates before its target hits, the monitor flags it `failed` and you sell manually
  on pons.family. (GMGN's `order quote` *can* route these — a possible future integration.)
- **ERC‑20‑quoted launches.** Only native‑ETH launches are supported; the sniper skips the rest.

---

## Setup (3 steps)

```bash
npm install
npm run setup      # generates secrets into .env — you never edit .env by hand
npm run dev        # http://localhost:3000
```

Then in the browser:

1. **Create wallet** – one click. Key is encrypted into `data/bot.keystore.json` with the
   passphrase `npm run setup` generated. Back up that file **and** your `.env` separately.
2. **Add funds** – copy the address shown, send it ~0.02 ETH on **Robinhood Chain**.
3. **Buy** – paste a token address, pick a preset (Safe / Balanced / Moonshot) or set your
   own %, hit Buy. While the switch says **DRY‑RUN** nothing is sent — you just get a preview.

Optional sanity check of chain + contract wiring:

```bash
npm run smoke
npm run smoke -- 0xTOKEN   # resolve a token: curve, price, graduation %
```

---

## Going live

Flip the **DRY‑RUN → LIVE** switch in the top‑right of the UI (it asks for confirmation).
No `.env` edit, no restart. Flip it back any time. The setting is stored in
`data/engine.json` and overrides `ENGINE_LIVE` in `.env`.

Recommended first live trade: **0.003 ETH** with a tight take‑profit, or buy then hit
**Sell now** to prove the round trip. Scale up only after you've watched an auto‑sell fire
and settle.

The monitor runs **inside the Next.js server process** (`src/instrumentation.ts`) — fine
for a local machine or an always‑on VPS, but **not** serverless (Vercel). A public
deployment needs the monitor on a persistent worker host, a per‑user keystore, and real
auth (local requests are trusted automatically; remote requests need `ENGINE_API_TOKEN`).

---

## Layout

| Path | Purpose |
| --- | --- |
| `src/lib/chain.ts` | viem client for Robinhood Chain |
| `src/lib/pons/addresses.ts` | verified contract addresses + event topics |
| `src/lib/pons/abis.ts` | hand‑written minimal ABIs (curve, factory, ERC‑20) |
| `src/lib/pons/pricing.ts` | bonding‑curve math (port of `PonsV2BondingCurveMath`) |
| `src/lib/pons/tokens.ts` | resolve a token → curve, price, graduation state |
| `src/lib/pons/swap.ts` | `buyOnCurve` / `sellOnCurve` from the bot wallet |
| `src/lib/wallet/` | encrypted keystore + viem wallet client |
| `src/lib/db/` | `node:sqlite` positions store + engine log |
| `src/lib/engine/rules.ts` | pure TP / SL / trailing exit evaluation |
| `src/lib/engine/executor.ts` | perform the sell, record outcome |
| `src/lib/engine/monitor.ts` | the polling loop (globalThis‑backed singleton) |
| `src/lib/engine/liveState.ts` | the DRY‑RUN / LIVE switch (`data/engine.json`) |
| `src/lib/api.ts` | JSON helpers + auth (local trusted, remote needs token) |
| `src/instrumentation.ts` | boots the monitor on server start |
| `src/app/api/*` | REST: wallet + create, token lookup, positions CRUD, engine status + live toggle |
| `src/app/Dashboard.tsx` | the whole UI |
| `scripts/setup.ts` | generate `.env` secrets |
| `scripts/wallet-init.ts` | create/import the bot wallet from the CLI (the UI button does the same) |
| `scripts/smoke.ts` | connectivity + contract check |

## Key contracts (Robinhood Chain 4663)

- pons v2 factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`
- `TokenLaunched` topic0 `0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607`
- WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`
- Source of truth: [github.com/ponsdotdev/ponsfamily](https://github.com/ponsdotdev/ponsfamily) `contractsV2/src/v2`
