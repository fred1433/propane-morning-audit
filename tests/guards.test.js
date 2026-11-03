// One test per guard added after the review of the finished demo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepare } from '../src/engine.js';
import { parseFile } from '../src/parse.js';
import { tenths } from '../src/util.js';
import { rawFiles, edit, run, DAYS } from './helpers.js';

const raw = rawFiles();
const read = (path) => { const f = raw.find((x) => x.path === path); return parseFile(f.path, f.text, f.received_at); };

test('trucks are never loaded above 85 % of their tank, nor run below empty', () => {
  const trucks = read('reference/trucks.csv').rows;
  for (const day of DAYS) {
    const gauge = read(`days/${day}/gauge_sheet.csv`).rows; const rack = read(`days/${day}/loading_rack.csv`).rows; const meter = read(`days/${day}/meter_register.csv`).rows;
    for (const t of trucks) {
      const cap = Math.floor(Number(t.tank_wc_gal) * Number(t.max_fill_pct) / 100) * 10;
      let content = tenths(gauge.find((g) => g.vessel === t.truck).net_gal);
      const events = [...rack.filter((r) => r.truck === t.truck).map((r) => ({ at: r.time.slice(11), q: tenths(r.net_gal) })), ...meter.filter((r) => r.truck === t.truck && r.record === 'TICKET').map((r) => ({ at: r.time, q: -tenths(r.net_gal) }))].sort((a, b) => a.at.localeCompare(b.at) || b.q - a.q);
      for (const e of events) { content += e.q; assert.ok(content <= cap, `${day} ${t.truck} at ${e.at}: ${content / 10} gal above ${cap / 10}`); assert.ok(content >= 0, `${day} ${t.truck} at ${e.at}: below empty`); }
      for (const g of gauge.filter((x) => x.vessel === t.truck)) assert.ok(Number(g.reading_pct) <= Number(t.max_fill_pct), `${day} ${t.truck} gauge ${g.reading_pct} %`);
    }
  }
});

test('ten distinct accounts per truck and day; no residence delivered twice in the week; R-1137 only at its PreBuy price', () => {
  const seen = new Map();
  for (const day of DAYS) {
    const meter = read(`days/${day}/meter_register.csv`).rows.filter((r) => r.record === 'TICKET');
    for (const truck of new Set(meter.map((r) => r.truck))) {
      const accts = meter.filter((r) => r.truck === truck).map((r) => r.account);
      assert.equal(new Set(accts).size, accts.length, `${day} ${truck}: an account delivered twice`);
    }
    for (const r of meter.filter((x) => x.account.startsWith('R-'))) { assert.ok(!seen.has(r.account), `${r.account} delivered ${seen.get(r.account)} and ${day}`); seen.set(r.account, day); }
    for (const r of read(`days/${day}/cargas_posted.csv`).rows.filter((x) => x.account === 'R-1137' && x.status !== 'VOID')) assert.equal(r.unit_price, '2.399');
  }
  // and the rule sees a PreBuy customer billed above the locked price
  const r = run(prepare(edit(raw, '2026-10-26/cargas_posted.csv', (t) => t.replace(/(R-1137,7684,B-14,PROPANE-BULK,260\.0,)2\.399,623\.74/, '$12.649,688.74').replace(/amount=([\d.]+)$/m, (m, a) => `amount=${(Number(a) + 65).toFixed(2)}`))), '2026-10-26');
  const d = r.dossiers.find((x) => x.rule === 'PRICE_PLAN' && x.status === 'flag');
  assert.ok(d, 'no flag for a PreBuy customer billed above the locked price'); assert.equal(d.amount, 6500); // (2.649 - 2.399) x 260.0
});

test('the POS export is held against the close on amounts, not only on receipts', () => {
  // one sale amount changed in Monday's export, its trailer updated, same number of receipts
  const changed = edit(raw, '2026-10-26/pos_sales.csv', (t) => {
    const lines = t.split('\n'); const i = lines.findIndex((l) => /,SALE,EXCH20,/.test(l)); const cols = lines[i].split(',');
    cols[7] = (Number(cols[7]) + 10).toFixed(2); lines[i] = cols.join(',');
    return lines.join('\n').replace(/amount=([\d.]+)/, (m, a) => `amount=${(Number(a) + 10).toFixed(2)}`);
  });
  const r = run(prepare(changed), '2026-10-26');
  const s = r.sources.find((x) => x.source === 'pos_sales');
  assert.equal(s.status, 'incomplete'); assert.match(s.detail, /amounts differ from the register close/);
  assert.ok(r.dossiers.some((d) => d.rule === 'POS_COMPLETENESS'));
  assert.equal(r.kpis.find((k) => k.id === 'counter_sales').status, 'unavailable');
});

test('values that cannot be read stop their check instead of becoming numbers', () => {
  // two tickets missing from Thursday's posted export: one line per ticket, total = sum of both
  const t1 = edit(raw, '2026-10-29/cargas_posted.csv', (t) => { const l = t.split('\n'); const i = l.findIndex((x) => /,5537,B-12,/.test(x)); const amt = Number(l[i].split(',')[9]); const g = Number(l[i].split(',')[7]); l.splice(i, 1); return l.join('\n').replace(/#trailer;rows=(\d+);net_gal=([\d.]+);amount=([\d.]+)/, (m, n, ng, a) => `#trailer;rows=${n - 1};net_gal=${(Number(ng) - g).toFixed(1)};amount=${(Number(a) - amt).toFixed(2)}`); });
  const d = run(prepare(t1), '2026-10-29').dossiers.find((x) => x.rule === 'TICKET_POSTED');
  assert.equal(d.fields.ticket, '5536, 5537');
  const lines = d.calc.filter(([k]) => k.endsWith('at plan price'));
  assert.equal(lines.length, 2);
  assert.ok(lines[0][1].startsWith('240.0 gal x $2.949/gal = $707.76'));
  // an unknown customer on a posted transaction: that line is not concluded, no $0.000 price
  const t2 = edit(raw, '2026-10-28/cargas_posted.csv', (t) => t.replace(',R-1123,4433,', ',R-9999,4433,'));
  const r2 = run(prepare(t2), '2026-10-28');
  const l2 = r2.lines.find((x) => x.rule === 'PRICE_PLAN' && x.scope === '88063');
  assert.equal(l2.status, 'suspended'); assert.match(l2.fields.reason, /R-9999/);
  assert.ok(!r2.dossiers.some((x) => x.status === 'flag' && x.rule === 'PRICE_PLAN'));
  // an unreadable price stops the line; a price with two decimals is read as it is
  const t3 = edit(raw, '2026-10-28/cargas_posted.csv', (t) => t.replace('R-1123,4433,B-11,PROPANE-BULK,180.0,2.499', 'R-1123,4433,B-11,PROPANE-BULK,180.0,abc'));
  assert.equal(run(prepare(t3), '2026-10-28').lines.find((x) => x.rule === 'PRICE_PLAN' && x.scope === '88063').status, 'suspended');
  const t4 = edit(raw, '2026-10-28/cargas_posted.csv', (t) => t.replace('R-1123,4433,B-11,PROPANE-BULK,180.0,2.499', 'R-1123,4433,B-11,PROPANE-BULK,180.0,2.95'));
  const d4 = run(prepare(t4), '2026-10-28').dossiers.find((x) => x.rule === 'PRICE_PLAN' && x.status === 'flag');
  assert.ok(!d4, '2.95 is the 2.950 price, at or above the 2.949 plan: no finding');
});

test('a truck with no previous register and no route does not break the meter checks', () => {
  const t = edit(raw, '2026-10-29/meter_register.csv', (x) => `${x}B-15,SHIFT_START,,08:00,,,,,500000.0,NET60,\nB-15,TICKET,9001,09:00,R-1160,101.2,100.0,60,500100.0,NET60,PRINTED\nB-15,SHIFT_END,,10:00,,,,,500100.0,NET60,\n`);
  const r = run(prepare(t), '2026-10-29');
  assert.equal(r.lines.find((l) => l.rule === 'METER_SEQUENCE' && l.scope === 'B-15').status, 'pass');
  assert.equal(r.lines.find((l) => l.rule === 'METER_BALANCE' && l.scope === 'B-15').status, 'pass');
  const p = r.dossiers.find((d) => d.rule === 'TICKET_POSTED' && d.scope === 'B-15');
  assert.equal(p.status, 'pending'); assert.match(p.headline, /no route for truck B-15/); assert.ok(!/undefined/.test(JSON.stringify(p)));
  // a totalizer whose base is unknown stops the balance for that truck
  const u = edit(raw, '2026-10-29/meter_register.csv', (x) => x.replace(/^(B-11,SHIFT_END,.*),NET60,$/m, '$1,UNKNOWN,'));
  assert.equal(run(prepare(u), '2026-10-29').lines.find((l) => l.rule === 'METER_BALANCE' && l.scope === 'B-11').status, 'suspended');
});

test('a settlement whose net does not follow from gross and fee is no longer an explanation', () => {
  const t = edit(raw, '2026-10-29/processor_settlement.csv', (x) => x.replace('1000.00,30.00,0.00,970.00', '1000.00,30.00,0.00,960.00'));
  const d = run(prepare(t), '2026-10-29').dossiers.find((x) => x.rule === 'DEPOSIT_TO_QBO' && x.scope === 'CD-1029-CARD');
  assert.equal(d.status, 'flag');
  const t2 = edit(raw, '2026-10-26/processor_settlement.csv', (x) => x.replace(/^(BATCH,CTR-1026,[^,]+,[\d.]+,[\d.]+,[\d.]+,)([\d.]+)$/m, (m, a, n) => `${a}${(Number(n) - 10).toFixed(2)}`));
  assert.equal(run(prepare(t2), '2026-10-26').lines.find((l) => l.rule === 'POS_CARD_TO_SETTLEMENT').status, 'flag');
});

test('a POS export of another day is not counted; the POS sentence names the real cause; half a cage record cannot conclude', () => {
  // Tuesday's slot receives Monday's export again (re-generated): it covers another day
  const monText = raw.find((f) => f.path === 'days/2026-10-26/pos_sales.csv').text.replace('generated=2026-10-26T18:06', 'generated=2026-10-27T18:06');
  const t = raw.map((f) => (f.path === 'days/2026-10-27/pos_sales.csv' ? { ...f, text: monText } : f));
  const r = run(prepare(t), '2026-10-27');
  assert.equal(r.sources.find((x) => x.source === 'pos_sales').status, 'stale');
  assert.equal(r.kpis.find((k) => k.id === 'counter_sales').status, 'unavailable');
  const d = r.dossiers.find((x) => x.rule === 'POS_COMPLETENESS');
  assert.equal(d.fields.partial, ''); assert.match(r.summary.find((s) => s.refs[0] === d.id).text, /covers Mon 26 Oct/);
  // export cut before the close, close present
  const t2 = edit(raw, '2026-10-26/pos_sales.csv', (x) => x.replace(';to=18:04;', ';to=16:00;'));
  const r2 = run(prepare(t2), '2026-10-26');
  assert.match(r2.summary.find((s) => s.refs[0] === r2.dossiers.find((x) => x.rule === 'POS_COMPLETENESS').id).text, /stops at 16:00 while the register closed at 18:04/);
  // cage counted, movements missing
  const r3 = run(prepare(raw.filter((f) => !f.path.endsWith('2026-10-29/cylinder_movements.csv'))), '2026-10-29');
  assert.equal(r3.ledger.find((l) => l.rule === 'CAGE_COUNT').state, 'suspended');
  assert.ok(r3.dossiers.some((x) => x.scope === 'cylinder_movements' && x.column === 'cannot'));
});

test('the lease cycle is named from its date and the last closed cycle is the one checked', () => {
  const mon = run(prepare(raw), '2026-10-26');
  assert.match(mon.lines.find((l) => l.rule === 'LEASE_BILLED' && l.scope === 'L-0112').note, /September cycle billed/);
  const thu = run(prepare(raw), '2026-10-29');
  assert.match(thu.dossiers.find((d) => d.rule === 'LEASE_BILLED').headline, /October cycle/);
});
