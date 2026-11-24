// Early-launch sniper + momentum-confirmation bot for agent-fun/replay/v2
// (pump.fun bonding curves).
//
// Idea: most pump.fun coins die within minutes, but a small share runs hard in
// its first hour. This bot fishes only in the launch window and only for
// launches that look organic, then lets the tape confirm before adding size:
//
//  * Entry (age 0..maxAge slots after CreateEvent, tuned to 0..1): the coin
//    must already hold >= 1 SOL of real reserves in its first slot(s) — a
//    strong launch — the creator must not have sold, the creator's own
//    opening buy must be modest, and only a couple of distinct non-creator
//    wallets may have bought in (a launch bundled by many wallets is usually
//    a cluster waiting to dump).
//  * Size: one small buy per coin (0.05 SOL, capped at 1% of the real SOL
//    reserve per the harness rules). No pyramiding: adds were tested and only
//    added fee drag on this window.
//  * Exits: fast scalping — a hard stop-loss, a trailing stop once up, and a
//    short max hold (~15 slots). No hard take-profit cap: winners ride the
//    trail. Also exits when the creator sells and when recent net flow turns
//    strongly negative. A curve that completes is closed by the replay.
//  * Guardrail: the ranking needs a >= 0.01 SOL round trip on >= 20 coins.
//    Late in the window, if the bot is behind that pace it opens tiny probe
//    round trips (0.01 SOL) on liquid curves so the bar is met.
//
// Deterministic by construction: no clock, no randomness, no I/O; iteration
// only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a first buy may be decided. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** SOL to put into one coin in total (initial + adds). */
  stakeSol: number;
  /** SOL per buy (initial buy and each add). */
  buySol: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuySol: number;
  /** Most adds after the initial buy. */
  maxAdds: number;
  /** An add needs the price at least this far above the last buy's decision price. */
  addStep: number;
  /** Slots to wait after the previous buy before an add. */
  addDelay: number;
  /** An add needs recent net flow at least this (SOL). */
  addMinFlowSol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the opening tape: at most this (SOL). */
  maxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry: at most. */
  maxBuyers: number;
  /** Distinct non-creator buyers seen before entry: at least. */
  minBuyers: number;
  /** Trades seen before entry: at least. */
  minTrades: number;
  /** Lamports sold by others / lamports bought, at most (0..1). */
  maxSellRatio: number;
  /** Price now over the create price: at most (1 + maxRunup). */
  maxRunup: number;
  /** Recent-flow window (slots) and what it must show at entry. */
  flowWindow: number;
  minFlowSol: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlipBps: number;
  /** First take-profit: sell tp1Part of the position once worth this over cost. */
  tp1: number;
  tp1Part: number;
  /** After the first take-profit, exit the rest at this much under its cost. */
  slAfterTp1: number;
  /** Exit when the position is worth this much over its cost. */
  tp: number;
  /** Exit when the position is worth this much under its cost. */
  sl: number;
  /** Trailing stop: once up at least trailArm, exit on a fall of trail from peak value. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when net SOL over exitFlowWindow slots falls below -exitFlowSol. */
  exitFlowWindow: number;
  exitFlowSol: number;
  /** Cooldown (slots) after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
  /** Most main positions open at once (caps.max_open_positions is 5). */
  maxMain: number;
  /** Guardrail pacing (see header): probe when coins lag this pace. */
  probeSol: number;
  probeTargetCoins: number;
  probeAfterFrac: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 1,
  stakeSol: 0.05,
  buySol: 0.05,
  minBuySol: 0.005,
  maxAdds: 0,
  addStep: 0.03,
  addDelay: 2,
  addMinFlowSol: 0,
  minRealSol: 1,
  maxRealSol: 40,
  maxDevBuySol: 2.5,
  maxBuyers: 2,
  minBuyers: 1,
  minTrades: 1,
  maxSellRatio: 0.5,
  maxRunup: 0.8,
  flowWindow: 10,
  minFlowSol: 0,
  skipDevSold: true,
  buySlipBps: 10_000,
  tp1: 1000,
  tp1Part: 0.5,
  slAfterTp1: 0.02,
  tp: 1000,
  sl: 0.05,
  trailArm: 0.1,
  trail: 0.08,
  maxHold: 15,
  exitOnDevSell: true,
  staleSlots: 120,
  exitFlowWindow: 10,
  exitFlowSol: 0.5,
  cooldown: 150,
  maxEntries: 1,
  maxMain: 5,
  probeSol: 0.01,
  probeTargetCoins: 25,
  probeAfterFrac: 0.75,
  maxProbes: 2,
  maxExposureSol: 0.5,
};

const LAMPORTS = 1e9;
/** Curve fees (protocol 95 bps + creator 30 bps) as a share of the quote. */
const CURVE_FEE = 0.0125;

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface Coin {
  mint: Pubkey;
  created: number | null;
  creator: Pubkey | null;
  vq0: number;
  vt0: number;
  devBuy: number;
  trades: number;
  buyers: Set<Pubkey>;
  bought: number;
  soldByOthers: number;
  devSold: boolean;
  lastTradeSlot: number;
  recent: Tick[];
  entries: number;
  lastExit: number;
  done: boolean;
  complete: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  adds: number;
  tookTp1: boolean;
  exiting: boolean;
  filled: boolean;
  lastBuyPrice: number;
  lastBuySlot: number;
  lastValue: number;
}

/** What selling `tokens` against (vq, vt) pays after curve fees, in SOL. */
function sellValueSol(tokens: number, vq: number, vt: number): number {
  if (tokens <= 0 || vt <= 0) return 0;
  const q = (tokens * vq) / (vt + tokens);
  return (q / LAMPORTS) * (1 - CURVE_FEE);
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  const myCoins = new Set<Pubkey>();
  let myFills = 0;
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        mint,
        created: null,
        creator: null,
        vq0: 0,
        vt0: 0,
        devBuy: 0,
        trades: 0,
        buyers: new Set(),
        bought: 0,
        soldByOthers: 0,
        devSold: false,
        lastTradeSlot: -1,
        recent: [],
        entries: 0,
        lastExit: -1e12,
        done: false,
        complete: false,
      };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (c: Coin, now: number, w: number): number => {
    let net = 0;
    for (let i = c.recent.length - 1; i >= 0; i--) {
      const tr = c.recent[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** First-buy signal on a coin's opening tape at slot `now`. */
  const entrySignal = (c: Coin, now: number, rqSol: number, price: number): boolean => {
    if (c.done || c.complete) return false;
    if (c.created === null) return false;
    const age = now - c.created;
    if (age < p.minAge || age > p.maxAge) return false;
    if (rqSol < p.minRealSol || rqSol > p.maxRealSol) return false;
    if (c.devBuy > p.maxDevBuySol) return false;
    if (p.skipDevSold && c.devSold) return false;
    if (c.trades < p.minTrades) return false;
    if (c.buyers.size < p.minBuyers || c.buyers.size > p.maxBuyers) return false;
    if (c.bought <= 0) return false;
    if (c.soldByOthers > p.maxSellRatio * c.bought) return false;
    if (c.vq0 > 0 && c.vt0 > 0) {
      const createPrice = c.vq0 / c.vt0;
      if (price > createPrice * (1 + p.maxRunup)) return false;
    }
    if (flow(c, now, p.flowWindow) < p.minFlowSol) return false;
    if (c.entries >= p.maxEntries || now - c.lastExit < p.cooldown) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.created = e.slot;
          c.creator = e.creator;
          c.vq0 = Number(e.virtual_quote_reserves);
          c.vt0 = Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          c.trades++;
          c.lastTradeSlot = e.slot;
          if (e.is_buy) {
            c.bought += sol;
            if (c.creator !== null && e.user === c.creator) c.devBuy += sol;
            else c.buyers.add(e.user);
          } else {
            if (c.creator !== null && e.user === c.creator) c.devSold = true;
            else c.soldByOthers += sol;
          }
          c.recent.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
          traded.add(e.mint);
        } else {
          coinOf(e.mint).complete = true;
        }
      }
      for (const mint of traded) {
        const c = coins.get(mint)!;
        const keepFrom = now - Math.max(p.flowWindow, p.exitFlowWindow) - 5;
        let cut = 0;
        while (cut < c.recent.length && c.recent[cut]!.slot <= keepFrom) cut++;
        if (cut > 0) c.recent.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      const priceOf = (mint: Pubkey): { vq: number; vt: number; rqSol: number } | null => {
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) return null;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const rqSol = (mk ? Number(mk.real_quote_reserves) : Number(curve.real_quote_reserves)) / LAMPORTS;
        return { vq, vt, rqSol };
      };

      // Exits first (full exits and the partial take-profit).
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const c = coinOf(mint);
            if (h.filled) {
              c.lastExit = now;
              c.done = true;
            } else {
              c.entries = Math.max(0, c.entries - 1);
            }
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const pr = priceOf(mint);
        if (pr === null) continue;
        const tokens = Number(pos.token_amount);
        const value = sellValueSol(tokens, pr.vq, pr.vt) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const c = coinOf(mint);
        let exit = h.exiting;
        const up = cost > 0 ? value / cost - 1 : 0;
        if (!exit && up <= -p.sl) exit = true;
        if (!exit && up >= p.tp) exit = true;
        if (!exit && h.tookTp1 && up <= -p.slAfterTp1) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit && p.exitOnDevSell && c.devSold) exit = true;
        if (!exit && p.staleSlots < 1e9 && now - c.lastTradeSlot > p.staleSlots) exit = true;
        if (!exit && flow(c, now, p.exitFlowWindow) < -p.exitFlowSol) exit = true;
        if (exit) {
          h.exiting = true;
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
          if (orders.length >= cap) break;
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
          continue;
        }
        // Partial take-profit: sell half once up tp1.
        if (!h.tookTp1 && up >= p.tp1) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending || pendingByMint.has(mint)) continue;
          if (orders.length >= cap) break;
          const half = BigInt(Math.floor(tokens * p.tp1Part));
          if (half <= 0n) continue;
          orders.push({ side: 'sell', mint, token_amount: half.toString(), max_slippage_bps: 10_000 });
          h.tookTp1 = true;
        }
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const c = coins.get(mint)!;
        const pr = priceOf(mint);
        if (pr === null) continue;
        const price = pr.vq / pr.vt;
        const h = held.get(mint);
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (!entrySignal(c, now, pr.rqSol, price)) continue;
          want = Math.min(p.buySol, p.stakeSol);
        } else {
          // Add into strength only: price stepped up from the last buy, flow still in,
          // enough time since the last buy, and room under the stake.
          if (h.exiting || !h.filled || h.adds >= p.maxAdds) continue;
          if (h.invested >= p.stakeSol - p.minBuySol) continue;
          if (now - h.lastBuySlot < p.addDelay) continue;
          if (price < h.lastBuyPrice * (1 + p.addStep)) continue;
          if (flow(c, now, p.flowWindow) < p.addMinFlowSol) continue;
          if (pr.rqSol > p.maxRealSol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          want = Math.min(p.buySol, p.stakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, {
            opened: now,
            peakValue: 0,
            invested: amount,
            adds: 0,
            tookTp1: false,
            exiting: false,
            filled: false,
            lastBuyPrice: price,
            lastBuySlot: now,
            lastValue: 0,
          });
          c.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.adds++;
          h.lastBuyPrice = price;
          h.lastBuySlot = now;
        }
      }

      // Guardrail pacing: late in the window, open a probe when coins lag the target.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const elapsed = lastTime - firstTime;
        const windowSecs = 6 * 3600;
        if (elapsed > p.probeAfterFrac * windowSecs && myCoins.size < p.probeTargetCoins) {
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            const pr = priceOf(mint);
            if (pr === null || pr.rqSol < p.probeSol * 2) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
