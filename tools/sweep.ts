// Parameter sweep over tools/sim.ts: every combination of the given values,
// ranked by net PnL with both window halves shown (a setting that wins only
// in one half is a fluke, not an edge).
//
//   node tools/sweep.ts '{"tp":[0.4,1],"sl":[0.08,0.12]}' [--base '{"maxAge":10}'] [--top 20]

import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate, type Dataset } from './sim.ts';

const args = process.argv.slice(2);
const get = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const kit = get('--kit') ?? '/tmp/kit-pumpfun-x/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-kit';
const grid: Record<string, unknown[]> = JSON.parse(args[0] ?? '{}');
const base: Params = { ...DEFAULT_PARAMS, ...JSON.parse(get('--base') ?? '{}') };
const top = Number(get('--top') ?? '25');

const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('pilot-pumpfun-replay', 'dev', ds.sha256));
const mid = Math.floor(ds.batches.length / 2);
const half = (lo: number, hi: number): Dataset => {
  const batches = ds.batches.slice(lo, hi);
  const created = new Set<string>();
  for (const b of batches) for (const e of b.events) if (e.event === 'CreateEvent') created.add(e.mint);
  const kept = batches
    .map((b) => ({ slot: b.slot, events: b.events.filter((e: any) => created.has(e.mint)) }))
    .filter((b) => b.events.length > 0);
  return { sha256: ds.sha256, events: ds.events, endSlot: batches[batches.length - 1]!.slot, batches: kept };
};
const h1 = half(0, mid);
const h2 = half(mid, ds.batches.length);

let combos: Record<string, unknown>[] = [{}];
for (const [k, vs] of Object.entries(grid)) combos = combos.flatMap((c) => vs.map((v) => ({ ...c, [k]: v })));

const rows: { label: string; net: number; n1: number; n2: number; fills: number; mints: number; dd: number; wins: number }[] = [];
for (const c of combos) {
  const p = { ...base, ...c } as Params;
  const r = simulate(ds, hello, createStrategy(p));
  const r1 = simulate(h1, hello, createStrategy(p));
  const r2 = simulate(h2, hello, createStrategy(p));
  rows.push({
    label: JSON.stringify(c),
    net: Number(r.netPnl) / 1e9,
    n1: Number(r1.netPnl) / 1e9,
    n2: Number(r2.netPnl) / 1e9,
    fills: r.fills,
    mints: r.mints,
    dd: r.maxDrawdown,
    wins: r.trips.filter((t) => t.pnl > 0n).length,
  });
}
rows.sort((a, b) => b.net - a.net);
for (const r of rows.slice(0, top)) {
  console.log(
    `${r.net.toFixed(4).padStart(8)} [${r.n1.toFixed(3)} ${r.n2.toFixed(3)}]  fills ${String(r.fills).padStart(4)} mints ${String(r.mints).padStart(3)} wins ${String(r.wins).padStart(3)} dd ${(r.dd * 100).toFixed(1)}%  ${r.label}`,
  );
}
console.log(`${combos.length} combos`);
