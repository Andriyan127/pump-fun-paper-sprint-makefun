// Offline backtest of strategy.ts on the kit's dev window with the local engine
// port (tools/sim.ts).
//
//   node tools/backtest.ts <kit dir> ['{"tp":0.5}'] [--trips] [--halves] [--log-orders <file>]
//
// Prints net PnL, fills, coins, round trips, wins, drawdown and reject reasons.
// --halves also runs the first and second half of the dataset separately, so a
// setting that wins only in one half is flagged as a fluke, not an edge.
// --log-orders writes one JSON line per batch of the orders the strategy
// returned (for the determinism check: run twice, diff the files).

import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate, type Dataset } from './sim.ts';
import { writeFileSync } from 'node:fs';

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node tools/backtest.ts <kit dir> [params json] [--trips] [--halves] [--log-orders <file>]');
  process.exit(2);
}
const overrides = process.argv[3] !== undefined && process.argv[3].startsWith('{') ? (JSON.parse(process.argv[3]) as Partial<Params>) : {};
const params = { ...DEFAULT_PARAMS, ...overrides };
const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('pilot-pumpfun-replay', 'dev', ds.sha256));
const sol = (x: bigint) => (Number(x) / 1e9).toFixed(6);

function report(label: string, d: Dataset, logFile?: string) {
  let orderLog: string[] | null = null;
  let strat = createStrategy(params);
  if (logFile !== undefined) {
    orderLog = [];
    const inner = strat;
    const orig = inner.onBatch.bind(inner);
    strat = {
      onBatch: (state: any, batch: any) => {
        const orders = orig(state, batch) as any;
        orderLog!.push(JSON.stringify({ seq: batch.seq, slot: batch.slot, orders }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
        return orders;
      },
    };
  }
  const r = simulate(d, hello, strat);
  const wins = r.trips.filter((t) => t.pnl > 0n).length;
  const bigTrips = r.trips.filter((t) => t.pnl > 0n).length;
  const qualifying = new Set<string>();
  for (const t of r.trips) {
    // A round trip counts toward the bar when the coin was traded for >= 0.01 SOL;
    // trips here are per-coin open/close pairs, so count distinct coins with any trip.
    qualifying.add(t.mint);
  }
  console.log(
    `${label}: net ${sol(r.netPnl)} SOL  fills ${r.fills}  coins ${r.mints}  trips ${r.trips.length}  wins ${wins}  ` +
      `dd ${(r.maxDrawdown * 100).toFixed(2)}%  rejected ${r.rejected} ${JSON.stringify(r.rejectReasons)}  failed ${r.failed}  ` +
      `qualifying-coins ${qualifying.size}`,
  );
  const noFail = simulate(d, hello, createStrategy(params), { failKey: null });
  const twoX = simulate(d, hello, createStrategy(params), { feeMultiplier: 2n });
  console.log(`${label}: without failed txs ${sol(noFail.netPnl)}  at 2x fees ${sol(twoX.netPnl)}`);
  if (orderLog !== null && logFile !== undefined) {
    writeFileSync(logFile, orderLog.join('\n') + '\n');
  }
  if (process.argv.includes('--trips')) {
    for (const t of r.trips) console.log('  trip', t.mint.slice(0, 8), `open@${t.open}`, `hold ${t.close - t.open} slots`, sol(t.pnl));
  }
  return r;
}

const logIdx = process.argv.indexOf('--log-orders');
const logFile = logIdx >= 0 ? process.argv[logIdx + 1] : undefined;
report('full', ds, logFile);

if (process.argv.includes('--halves')) {
  const mid = Math.floor(ds.batches.length / 2);
  const half = (lo: number, hi: number): Dataset => {
    // Keep only coins created inside this half: the sim (like the real
    // harness) expects every trade to follow its coin's CreateEvent.
    const batches = ds.batches.slice(lo, hi);
    const created = new Set<string>();
    for (const b of batches) for (const e of b.events) if (e.event === 'CreateEvent') created.add(e.mint);
    const kept = batches
      .map((b) => ({ slot: b.slot, events: b.events.filter((e: any) => created.has(e.mint)) }))
      .filter((b) => b.events.length > 0);
    return { sha256: ds.sha256, events: ds.events, endSlot: batches[batches.length - 1]!.slot, batches: kept };
  };
  report('half-1', half(0, mid));
  report('half-2', half(mid, ds.batches.length));
}
