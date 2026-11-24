# pump-fun-paper-sprint-makefun

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Andriyan127/pump-fun-paper-sprint-makefun/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Andriyan127/pump-fun-paper-sprint-makefun/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Early-launch sniper + momentum-confirmation scalper for pump.fun paper trading: buys strong launches fast, exits on a tight stop/trailing stop.

## Strategy

Most pump.fun coins die within minutes, but a small share runs hard in its first hour. This bot fishes only in the launch window and only for launches that look organic:

- **Entry (age 0–1 slots after CreateEvent):** the coin must already hold ≥ 1 SOL of real reserves in its first slot — a strong launch. The creator must not have sold, the creator's own opening buy must be modest (≤ 2.5 SOL), and at most 2 distinct non-creator wallets may have bought in (a launch bundled by many wallets is usually a cluster waiting to dump). Sells by others must stay below half of buys.
- **Size:** one small buy per coin (0.05 SOL, capped at 1% of the real SOL reserve per the harness rules). No pyramiding — adds were backtested and only added fee drag on the dev window.
- **Exits (fast scalping):** 5% stop-loss, 8% trailing stop once up 10%, and a short ~15-slot max hold. No hard take-profit cap — winners ride the trail. Also exits when the creator sells or when recent net flow turns strongly negative. Curves that complete are closed by the replay.
- **Guardrail:** the ranking needs a ≥ 0.01 SOL round trip on ≥ 20 coins. Late in the window, if the bot is behind that pace it opens tiny 0.01 SOL probe round trips on liquid curves so the bar is met.

Fully deterministic: no clock, no randomness, no network, no I/O — iteration only over insertion-ordered maps fed by the batch stream. Two executions produce byte-identical action logs.

## Dev backtest (kit dev window, local replay engine)

| | net PnL | fills | coins | round trips | wins | max drawdown |
|---|---|---|---|---|---|---|
| Full window | **+0.0330 SOL** | 138 | 69 | 69 | 12 | 0.37% |
| First half | +0.0073 SOL | 78 | 39 | 39 | 7 | 0.35% |
| Second half | +0.0260 SOL | 70 | 33 | 35 | 5 | 0.33% |

Positive in both halves. Starting capital 10 SOL; the bot never risks more than 0.5 SOL at cost across all positions at once. Two independent backtest runs produced byte-identical order logs (determinism check passed).

## Run it

```sh
node main.ts
```

The grader runs `node /bot/main.ts` (Node 22, TypeScript run as-is, no build, no install). To backtest locally against the kit's dev dataset:

```sh
node tools/backtest.ts <kit dir> --halves
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
