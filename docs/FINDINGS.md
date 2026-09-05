# What we tested, and what it did

Every number here comes from replaying real launches on Robinhood Chain — up to
114,544 of them across a five-day window, including both ETH-quoted and
stock/stablecoin-quoted tokens. Nothing is simulated market data.

The short version: **twelve strategies were tested and ten are dead.** The two
that survive are statistically real and economically marginal. If you are
looking for a reason to trust an automated strategy here, this document is
mostly a list of reasons not to.

---

## The base rates

| | |
|---|---|
| launches in five days | 114,544 |
| graduate to a pool | **~2%** |
| ETH-quoted | 1.51% |
| stock/stablecoin-quoted | 2.57% |
| median graduated token, 1h after migration | **−32%** |
| median graduated token, 12h after | **−59%** |
| graduated tokens that trade at all | **~15%** |

Graduation is not the start of a run. On the median it is the top.

## The one thing that predicts anything

| other buyers in the first 20 seconds | graduation rate |
|---|---|
| 0 | **0.11%** |
| 1 | 0.37% |
| 2–3 | 0.44% |
| 4–7 | 0.74% |
| **8+** | **5.65%** |

A 51× spread, and it dwarfs every other signal combined. It is also the one
thing no filter can manufacture: it measures whether real people showed up.

## Strategies that do not work

**Sniping every launch.** Negative on all nine exit rules across 88,602
entries, on both quote types. Best case −1.8%, worst −10.6%.

**Buying dips.** The drawdown is an *anti*-signal, monotonically: on the same
liquidity band and exit, no-dip returned −4.6%, a 25% dip −14.3%, a 40% dip
−16.8%. Deeper is worse, every time.

**Fibonacci retracements.** On a bonding curve, price scales with the square of
the reserve, so a 0.786 retracement means the curve lost 54% of its money. Only
three tokens in the whole window managed that while retaining any liquidity.

**Buying near graduation.** Also monotonic, also backwards: entering at 60–70%
of the threshold returned −4.9%, at 85–88% −8.5%. The closer you get, the less
room remains and the same downside applies.

**Holding through migration.** Mean +5.2% but a 5%-trimmed mean of −12.6% and a
median of −18% — the average was a handful of outliers. See the note on
trimmed means below.

**Buying dips in the pool, after graduation.** Tested separately because the
curve tops out near $60k and everything above that is a different asset. Median
outcome −30%, and again dip depth made no difference: a 20% drawdown and a 60%
drawdown performed identically.

**Picking the winner of a narrative wave.** When a ticker is minted repeatedly,
the member with the most early buyers really is the one that graduates 57% of
the time. It still loses money, because that member is entered at a **53.7%
higher price**. The information and the cost of acting on it arrive together.

**Entering earlier.** The anti-snipe tax is only 3 seconds, so a 4-second entry
looked like free money against the 20-second default. It was worse on every
exit rule. The delay is not a tax dodge — it is an observation window, and what
it buys is the buyer-count signal above.

## Strategies that survive

**Buyer reputation.** Requiring that several of a curve's existing buyers were
previously early on a token that graduated:

| min proven buyers | n | mean | 95% CI |
|---|---|---|---|
| 0 (control) | 18,175 | −1.4% | [−2.2, −0.6] |
| 2 | 17,051 | −0.5% | [−1.3, +0.3] |
| **4** | 12,253 | **+2.6%** | **[+1.5, +3.5]** |

Best book **+3.1%** on 21,151 trades, CI [+2.2, +3.9]. The edge is concentrated
in stock-quoted tokens (**+4.9%**) and is not significant on ETH-quoted ones
(+0.7%, CI spans zero).

**Coordinated buyers.** Clustering wallets that repeatedly appear early on the
same tokens identifies operators running many addresses. Entering when several
of one cluster have bought returns **+1.6%** against a **−3.6%** control.

Both are real. Both have negative medians — the return comes from rare large
winners, not from being right often.

## Two traps worth knowing

**Trimmed means.** Several results looked strong on the mean and collapsed once
the top and bottom 5% were removed. If a mean is positive and the trimmed mean
is negative, one lucky token is carrying the result and it will not repeat.

**Lookahead.** Measuring "coordinated buyers" over a token's whole life gave
+35%. Measuring it as of the moment you would actually buy gave +1.6%, because
**57% of the coordination arrives after the entry**. Any metric computed over a
token's full history is describing something you could not have known.

## Launching, as opposed to trading

Creator fees are earned on trade volume regardless of price direction, which
makes issuing structurally different from trading:

| deployer's total launches | avg fee per launch | vs the 0.0005 ETH launch fee |
|---|---|---|
| 1 | 0.0040 ETH | **+0.0035** |
| 2–4 | 0.0029 | +0.0024 |
| 5–19 | 0.0015 | +0.0010 |
| 20–99 | 0.0004 | **−0.00006** |

A launch that attracts volume pays for itself several times over. Spraying
launches does not: 83 deployers with 20+ launches and no graduations netted
**0.21 ETH between them** across 3,281 launches.

Choices that correlate with graduating, all measured:

- stock/stablecoin pair 2.57% vs ETH 1.51%
- creator tax 201–300bps **3.76%**; 0bps 1.97%; 501+bps **0.29%**
- ticker 4–5 chars 1.79%; 9–12 chars 0.87%; 13+ chars 0.47%
- ALL CAPS 1.68% vs mixed case 1.15%; digits 1.05%

All of which is worth a fraction of the 51× that comes from having an audience.
