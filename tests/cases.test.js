// Every case written by hand in expected/cases.json is replayed against the engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { files, cases, run } from './helpers.js';

const FS = files();
const modes = (c) => c.pos_close || [undefined];

function recordFound(d, rec) {
  const [src, ...ids] = rec.split(':');
  const cards = (d.evidence || []).filter((c) => (c.file || '').includes(src));
  return cards.length > 0 && ids.every((id) => cards.some((c) => c.file.includes(id) || c.title.includes(id) || c.rows.some((r) => r.cells.some((x) => String(x).includes(id)))));
}

for (const c of cases()) {
  for (const mode of modes(c)) {
    for (const day of [c.day, ...(c.also_days || [])]) {
      test(`${c.id} on ${day}${mode ? ` (POS close ${mode})` : ''}`, () => {
        const r = run(FS, day, mode);
        if (c.kind === 'find') {
          const d = r.dossiers.find((x) => x.rule === c.rule && String(x.scope) === c.scope);
          assert.ok(d, `no dossier for ${c.rule} ${c.scope}`);
          assert.equal(d.status, c.status);
          assert.equal(d.qualification, c.qualification);
          if (c.amount_cents !== undefined) assert.equal(d.amount, c.amount_cents);
          if (c.qty_tenths !== undefined) assert.equal(d.qty, c.qty_tenths);
          if (c.expected_full !== undefined) { assert.equal(d.fields.expected, String(c.expected_full)); assert.equal(d.fields.counted, String(c.counted_full)); }
          if (c.account_differences) {
            const [more] = Object.entries(c.account_differences).find(([, v]) => v > 0); const [less] = Object.entries(c.account_differences).find(([, v]) => v < 0);
            assert.equal(d.fields.acct_more, more); assert.equal(d.fields.acct_less, less);
          }
          for (const rec of c.records || []) assert.ok(recordFound(d, rec), `record ${rec} not in the dossier's evidence`);
        } else if (c.kind === 'quiet') {
          if (c.source_status) {
            const l = r.fileLog.find((x) => x.path === c.source_status.file);
            assert.equal(l?.status, c.source_status.status);
          } else {
            const ls = r.lines.filter((l) => l.rule === c.rule && String(l.scope) === c.scope);
            assert.ok(ls.length, `rule ${c.rule} did not check ${c.scope}`);
            for (const l of ls) assert.ok(c.allowed_status.includes(l.status), `${c.rule} ${c.scope} is ${l.status}`);
            assert.ok(!r.dossiers.some((d) => d.status === 'flag' && String(d.scope) === c.scope), 'raised as a finding');
          }
        } else {
          if (c.source) {
            const s = r.sources.find((x) => x.source === c.source);
            assert.equal(s.status, c.source_status);
            if (c.covers) assert.equal(s.covers, c.covers);
            if (c.rows_received) { assert.equal(s.received_rows, c.rows_received); assert.equal(s.announced_rows, c.rows_announced); }
            const d = r.dossiers.find((x) => x.rule === 'SOURCE_FRESH_COMPLETE' && x.scope === c.source);
            assert.ok(d, 'no data dossier');
            assert.deepEqual([...d.suspends].sort(), [...c.suspends].sort());
          } else {
            const d = r.dossiers.find((x) => x.rule === c.rule && String(x.scope) === (c.scope || x.scope));
            assert.ok(d, `no dossier for ${c.rule}`);
            assert.equal(d.status, c.status);
            if (c.suspends) assert.deepEqual([...d.suspends].sort(), [...c.suspends].sort());
            if (c.tickets) assert.equal(d.fields.tickets, c.tickets.join(', '));
          }
          if (c.kpi_partial) assert.equal(r.kpis.find((k) => k.id === c.kpi_partial).status, 'partial');
          if (c.kpi_unavailable) assert.equal(r.kpis.find((k) => k.id === c.kpi_unavailable).status, 'unavailable');
        }
      });
    }
  }
}

test('no finding outside the planted cases', () => {
  const planted = new Set(cases().filter((c) => c.kind === 'find').map((c) => `${c.rule}|${c.scope}`));
  for (const day of ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']) {
    for (const mode of [undefined, 'received', 'missing']) {
      for (const d of run(FS, day, mode).dossiers.filter((x) => x.status === 'flag')) assert.ok(planted.has(`${d.rule}|${d.scope}`), `${day}: unexpected finding ${d.rule} ${d.scope}`);
    }
  }
});
