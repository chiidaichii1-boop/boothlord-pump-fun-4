# Pump.fun Paper Sprint: Any Bot Can Win

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/chiidaichii1-boop/boothlord-pump-fun-4/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/chiidaichii1-boop/boothlord-pump-fun-4/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A deterministic new-mint momentum bot for the [Pump.fun Paper Sprint](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun.

## Strategy

- **Buy** a mint only when it is young (first seen within ~3,600 slots), has at least
  2 SOL of real reserves, has already run at least 15% above its first-seen price,
  and its recent trades are dominated by buys (at least 7 of the last 10).
- **Size** ~0.09 SOL per buy, capped at 1% of the mint's real SOL reserves and never
  below the 0.01 SOL round-trip floor.
- **Exit** on take-profit +60%, stop-loss -30%, a trailing stop 20% below the best
  price since entry, or a 7,200-slot age limit — whichever comes first.
- **Deterministic**: every price comparison is BigInt cross-multiplication on the
  curve's virtual reserves. No floating point, no clock, no environment, no
  randomness — the same replay always produces the same orders.

## Run

`main.ts` runs on Node 22 via the `agent-fun/replay/v2` harness (`vendor/makefun-bot.ts`).

Referral code: `7g64vnx0`
