// Behaviour on situations the planted cases do not cover by themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepare } from '../src/engine.js';
import { rawFiles, edit, run, DAYS } from './helpers.js';

const shape = (r) => r.dossiers.map((d) => `${d.id}|${d.rule}|${d.scope}|${d.status}|${d.amount ?? ''}|${d.qty ?? ''}`);
const minuteLater = (ts) => `${ts.slice(0, 15)}${String(Number(ts.slice(15, 16)) === 9 ? 9 : Number(ts.slice(15, 16)) + 1)}`;

test('ingesting every file a second time creates nothing', () => {
  const raw = rawFiles(); const once = prepare(raw);
  const twice = prepare([...raw, ...raw.map((f) => ({ ...f, path: `${f.path}.resent`, received_at: minuteLater(f.received_at) }))]);
  for (const day of DAYS) for (const mode of [undefined, 'received', 'missing']) {
    const a = run(once, day, mode); const b = run(twice, day, mode);
    assert.deepEqual(shape(b), shape(a), `${day} ${mode}`);
    assert.deepEqual(b.kpis.map((k) => k.value), a.kpis.map((k) => k.value));
  }
});

test('a missing source suspends the checks that need it and only those', () => {
  const raw = rawFiles().filter((f) => f.path !== 'days/2026-10-26/qbo_deposits.json');
  const r = run(prepare(raw), '2026-10-26');
  const susp = r.ledger.filter((l) => l.state === 'suspended').map((l) => l.rule).sort();
  assert.deepEqual(susp, ['DEPOSIT_TO_QBO', 'POS_CARD_TO_SETTLEMENT', 'POS_CASH_TO_QBO']);
  assert.equal(r.ledger.find((l) => l.rule === 'TICKET_POSTED').state, 'pass');
  const d = r.dossiers.find((x) => x.scope === 'qbo_deposits');
  assert.equal(d.sourceStatus, 'missing');
  assert.equal(r.kpis.find((k) => k.id === 'deposits').status, 'unavailable');
});

test('the POS selector changes what the engine concludes', () => {
  const fs = prepare(rawFiles());
  const missing = run(fs, '2026-10-29', 'missing'); const received = run(fs, '2026-10-29', 'received');
  assert.equal(missing.kpis.find((k) => k.id === 'counter_sales').status, 'partial');
  assert.equal(received.kpis.find((k) => k.id === 'counter_sales').status, 'ok');
  assert.notEqual(missing.kpis.find((k) => k.id === 'counter_sales').value, received.kpis.find((k) => k.id === 'counter_sales').value);
  assert.ok(!missing.dossiers.some((d) => d.rule === 'POS_CASH_TO_QBO'));
  assert.ok(received.dossiers.some((d) => d.rule === 'POS_CASH_TO_QBO' && d.status === 'flag'));
  assert.equal(received.rerunAt, '2026-10-30T09:45');
  // on a normal day, withholding the close suspends the counter checks
  const mon = run(fs, '2026-10-26', 'missing');
  assert.deepEqual(mon.dossiers.find((d) => d.rule === 'POS_COMPLETENESS').suspends.sort(), ['POS_CARD_TO_SETTLEMENT', 'POS_CASH_TO_QBO']);
});

test('changing a source amount changes the result', () => {
  // the processor fee on Thursday's office batch becomes 25.00: the 30.00 difference is no longer explained
  const raw = edit(rawFiles(), '2026-10-29/processor_settlement.csv', (t) => t.replace('1000.00,30.00,0.00,970.00', '1000.00,25.00,0.00,975.00'));
  const d = run(prepare(raw), '2026-10-29').dossiers.find((x) => x.rule === 'DEPOSIT_TO_QBO' && x.scope === 'CD-1029-CARD');
  assert.equal(d.status, 'flag'); assert.equal(d.qualification, 'accounting_difference');
  // the missing ticket weighs 250.0 gal instead of 240.0: the estimate follows (250.0 x 2.949)
  const raw2 = edit(rawFiles(), '2026-10-29/meter_register.csv', (t) => t.replace(/B-12,TICKET,5536,11:22,R-1088,240\.7,240\.0/, 'B-12,TICKET,5536,11:22,R-1088,250.7,250.0'));
  const r2 = run(prepare(raw2), '2026-10-29');
  assert.equal(r2.dossiers.find((x) => x.rule === 'TICKET_POSTED').amount, 73725);
  assert.equal(r2.ledger.find((l) => l.rule === 'METER_BALANCE').state, 'flag', 'the totalizer no longer matches the tickets');
});

test('a voided transaction and its replacement count once; two active ones are reported', () => {
  const fs = prepare(rawFiles());
  const tue = run(fs, '2026-10-27');
  assert.ok(tue.lines.find((l) => l.rule === 'ACTIVE_ONCE' && l.scope === '4423').note.includes('88033 voided'));
  // (the copy re-sent at 05:41 is dropped here, otherwise the later, unedited copy would be the one used)
  const raw = edit(rawFiles().filter((f) => !f.path.includes('(1)')), '2026-10-27/cargas_posted.csv', (t) => t.replace('GL-1027,VOID,', 'GL-1027,POSTED,'));
  const r = run(prepare(raw), '2026-10-27');
  // the trailer no longer agrees with the rows, so the export is first refused as a whole
  assert.equal(r.sources.find((s) => s.source === 'cargas_posted').status, 'incomplete');
  const raw3 = edit(raw, '2026-10-27/cargas_posted.csv', (t) => t.replace(/#trailer;rows=(\d+);net_gal=([\d.]+);amount=([\d.]+)/, (m, n, g, a) => `#trailer;rows=${n};net_gal=${(Number(g) + 142.4).toFixed(1)};amount=${(Number(a) + 419.94).toFixed(2)}`));
  const r3 = run(prepare(raw3), '2026-10-27');
  const d = r3.dossiers.find((x) => x.rule === 'ACTIVE_ONCE');
  assert.equal(d.scope, '4423'); assert.equal(d.status, 'flag');
});

test('a gauge reading with an unknown base is never corrected', () => {
  const r = run(prepare(rawFiles()), '2026-10-30');
  const d = r.dossiers.find((x) => x.rule === 'BULK_BALANCE');
  assert.equal(d.status, 'suspended'); assert.equal(d.qty, undefined);
});
