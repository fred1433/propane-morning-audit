// The summary quotes only its dossiers. Plausible wrong sentences are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySummary } from '../src/summary.js';
import { files, run, DAYS } from './helpers.js';

const FS = files();

test('the summary the code writes passes, every day and both POS states', () => {
  for (const day of DAYS) for (const mode of ['received', 'missing']) {
    const r = run(FS, day, mode); const v = verifySummary(r.summary, r);
    assert.ok(v.ok, `${day} ${mode}: ${v.errors.join('; ')}`);
    assert.equal(r.summary.length, r.dossiers.length + 1);
  }
});

const thu = run(FS, '2026-10-29', 'received');
const id = (rule) => thu.dossiers.find((d) => d.rule === rule).id;
const wrong = [
  ['amount taken from another dossier', [id('TICKET_POSTED')], 'Ticket 5536 (truck B-12, 240.0 gal net, printed 11:22) is not posted: billing to verify, $120.00 at the plan price.'],
  ['truck of another route', [id('TICKET_POSTED')], 'Ticket 5536 (truck B-11, 240.0 gal net, printed 11:22) is not posted after the 20:00 deadline: billing to verify, $707.76.'],
  ['two deposits added together', [id('DEPOSIT_TO_QBO')], 'Card deposits: $1,639.29 in total, the $47.51 difference is fees: explained.'],
  ['customer of another dossier', [id('LEASE_BILLED')], 'Lease L-0112 (tank T-5042, R-1088) has no charge for the $25.00 rent due Thu 1 Oct: billing to verify.'],
  ['a difference called a loss', [id('POS_CASH_TO_QBO')], 'Register close Z-1029 shows $624.70 in cash and the QuickBooks cash deposit is $504.70: a loss of $120.00, accounting difference.'],
  ['qualification dropped', [id('CAGE_COUNT')], 'Cage CG-07A at Palo Blanco Grocery: 22 full cylinders expected, 21 counted, 1 cylinder gone.'],
  ['date of another day', [id('TICKET_POSTED')], 'Ticket 5536 (truck B-12, 240.0 gal net) was not posted after the 20:00 deadline on Wed 28 Oct: billing to verify, $707.76.'],
  ['ticket of another dossier', [id('LEASE_BILLED')], 'Lease L-0112 (ticket 5536) has no charge for the $25.00 rent due Thu 1 Oct: billing to verify.'],
  ['unknown dossier', ['Z'], 'Everything balanced.'],
];
for (const [name, refs, text] of wrong) {
  test(`refused: ${name}`, () => {
    const v = verifySummary([{ refs, text }], thu);
    assert.equal(v.ok, false, text);
  });
}

test('refused: a business name from another dossier', () => {
  const lease = thu.dossiers.find((d) => d.rule === 'LEASE_BILLED');
  const v = verifySummary([{ refs: [lease.id], text: 'Lease L-0112 (tank T-5042, Palo Blanco Grocery) has no charge for the $25.00 rent due Thu 1 Oct: billing to verify.' }], thu);
  assert.equal(v.ok, false);
});
test('accepted although wrong: two figures swapped inside one sentence (the limit of a reference check)', () => {
  const dep = thu.dossiers.find((d) => d.rule === 'DEPOSIT_TO_QBO');
  const v = verifySummary([{ refs: [dep.id], text: 'Card deposit CD-1029-CARD: $970.00 in Cargas and $1,000.00 booked in QuickBooks; the $30.00 difference is the fee on settlement OFC-1029: explained.' }], thu);
  assert.equal(v.ok, true, 'if this starts failing, the README and the page can claim more');
});
