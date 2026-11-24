// Pump.fun Paper Sprint entry: early-launch sniper + momentum-confirmation bot.
// Run by the grader as `node /bot/main.ts`; the strategy lives in strategy.ts
// and the protocol in the vendored SDK shim (vendor/makefun-bot.ts, a copy of
// the kit's sdk/ts/makefun-bot.ts).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
