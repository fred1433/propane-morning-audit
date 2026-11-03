#!/usr/bin/env node
// Writes the fictional week (Mon 26 to Fri 30 October 2026) into fixtures/.
// Deterministic: same output on every run. Every company, customer, dealer, truck and amount is invented.
// The cases planted here are described, with their expected outcome, in expected/cases.json (written by hand,
// not produced by this script nor by the engine).
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const ROOT = new URL('../fixtures/', import.meta.url).pathname;
rmSync(ROOT, { recursive: true, force: true });

let seed = 20261026;
const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (a) => a[Math.floor(rnd() * a.length)];
const gal = (t) => (t / 10).toFixed(1);
const tenths = (s) => Math.round(Number(s) * 10);          // tenths of a gallon -> "240.0"
const usd = (c) => (c / 100).toFixed(2);         // cents -> "707.76"
const px = (m) => (m / 1000).toFixed(3);         // mills -> "2.949"
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const amt = (tenths, mills) => Math.round((tenths * mills) / 100); // gallons x price -> cents

const DAYS = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
const NEXT = { '2026-10-26': '2026-10-27', '2026-10-27': '2026-10-28', '2026-10-28': '2026-10-29', '2026-10-29': '2026-10-30', '2026-10-30': '2026-10-31' };
const mmdd = (d) => d.slice(5, 7) + d.slice(8, 10);
const manifest = [];
function put(rel, text, receivedAt) {
  const p = ROOT + rel; mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true });
  writeFileSync(p, text); manifest.push({ path: rel, received_at: receivedAt });
}
const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (head, cols, rows, trailer) => [head, cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(',')), ...(trailer ? [trailer] : [])].join('\n') + '\n';

// ---------- reference data ----------
const AREAS = ['Northeast', 'Upper Valley', 'Canutillo', 'Westway', 'Anthony', 'Vinton', 'Lower Valley', 'Socorro', 'Horizon City', 'Clint', 'Fabens', 'San Elizario', 'Montana Vista'];
const RES = Array.from({ length: 170 }, (_, i) => [`R-${1001 + i}`, AREAS[(i * 7) % AREAS.length]]);
const COM = [['C-2201', 'Tres Cruces Bakery', 'COM-A'], ['C-2203', 'Bajada Auto Body', 'COM-A'], ['C-2204', 'Agave Row Kitchen', 'COM-C'], ['C-2205', 'Mesa Caliza Steel Works', 'COM-A'], ['C-2206', 'Desert Lark Greenhouse', 'COM-B'], ['C-2207', 'Cactus Wren Tortilleria', 'COM-A'], ['C-2208', 'Hueco Rock Event Hall', 'COM-C'], ['C-2209', 'Coyote Gulch Car Wash', 'COM-B'], ['C-2210', 'Ocotillo Pallet Works', 'COM-D'], ['C-2212', 'Loma Verde Laundry', 'COM-B'], ['C-2213', 'Arroyo Lindo Tire Shop', 'COM-B'], ['C-2214', 'Pecan Row Dryer Shed', 'COM-C'], ['C-2215', 'Saguaro Lane Tamales', 'COM-A'], ['C-2216', 'Mesquite Flat Forklift Yard', 'COM-D'], ['C-2217', 'Cielo Azul Laundromat', 'COM-B'], ['C-2218', 'Tecolote Print Works', 'COM-A']];
const DEALERS = [['D-03', 'Tornillo Road Fuel Stop'], ['D-07', 'Palo Blanco Grocery'], ['D-11', 'Cholla Corner Store']];
const PLAN = { 'RES-STD': [['2026-10-01', 2899], ['2026-10-28', 2949]], 'COM-A': [['2026-10-01', 2459]], 'COM-B': [['2026-10-01', 2299]], 'COM-C': [['2026-10-01', 2559]], 'COM-D': [['2026-10-01', 2500]] };
const planOf = (acct) => (acct.startsWith('R-') ? 'RES-STD' : COM.find((c) => c[0] === acct)[2]);
const planPrice = (acct, day) => { let p = 0; for (const [from, m] of PLAN[planOf(acct)]) if (from <= day) p = m; return p; };
const REF_AT = '2026-10-25T20:00';
put('reference/customers.csv', csv('#source=customers;period=reference;generated=2026-10-25T20:00', ['account', 'name', 'type', 'area', 'price_plan'], [
  ...RES.map(([a, area]) => ({ account: a, name: `Residence ${a.slice(2)}`, type: 'RES', area, price_plan: 'RES-STD' })),
  ...COM.map(([a, n, p]) => ({ account: a, name: n, type: 'COM', area: 'El Paso', price_plan: p })),
  ...DEALERS.map(([a, n]) => ({ account: a, name: n, type: 'DEALER', area: 'El Paso County', price_plan: '' })),
]), REF_AT);
put('reference/price_plans.csv', csv('#source=price_plans;period=reference;generated=2026-10-25T20:00', ['plan', 'effective_from', 'price_per_gal'],
  Object.entries(PLAN).flatMap(([plan, l]) => l.map(([f, m]) => ({ plan, effective_from: f, price_per_gal: px(m) })))), REF_AT);
put('reference/prebuy_contracts.csv', csv('#source=prebuy_contracts;period=reference;generated=2026-10-25T20:00', ['contract', 'account', 'price_per_gal', 'gallons', 'start', 'end', 'gallons_used_before'], [
  { contract: 'PB-118', account: 'R-1137', price_per_gal: '2.399', gallons: '600.0', start: '2026-09-01', end: '2027-03-31', gallons_used_before: '0.0' },
  { contract: 'PB-121', account: 'R-1027', price_per_gal: '2.449', gallons: '500.0', start: '2026-09-01', end: '2027-03-31', gallons_used_before: '0.0' },
]), REF_AT);
put('reference/approvals.csv', csv('#source=approvals;period=reference;generated=2026-10-26T16:20', ['approval', 'account', 'ticket_no', 'price_per_gal', 'approved_by', 'approved_on'], [
  { approval: 'AP-311', account: 'C-2205', ticket_no: '7696', price_per_gal: '2.399', approved_by: 'Operations manager', approved_on: '2026-10-26' },
]), '2026-10-26T16:20');
put('reference/leases.csv', csv('#source=leases;period=reference;generated=2026-10-25T20:00', ['lease', 'tank', 'tank_wc_gal', 'owner', 'account', 'site', 'start', 'end', 'rent', 'frequency', 'due_day', 'cycle_close_day', 'next_due', 'waiver'], [
  { lease: 'L-0104', tank: 'T-3307', tank_wc_gal: '500', owner: 'Sample Propane Co.', account: 'C-2206', site: 'Greenhouse yard', start: '2025-01-15', end: '2027-01-14', rent: '25.00', frequency: 'MONTHLY', due_day: '1', cycle_close_day: '28', next_due: '', waiver: 'Rent waived while annual purchases reach 1000 gal; confirmed 2026-01-10' },
  { lease: 'L-0108', tank: 'T-4410', tank_wc_gal: '1000', owner: 'Sample Propane Co.', account: 'C-2204', site: 'Kitchen, rear lot', start: '2025-06-01', end: '2027-05-31', rent: '30.00', frequency: 'MONTHLY', due_day: '1', cycle_close_day: '28', next_due: '', waiver: '' },
  { lease: 'L-0112', tank: 'T-5042', tank_wc_gal: '500', owner: 'Sample Propane Co.', account: 'C-2207', site: 'Tortilleria, north wall', start: '2026-04-01', end: '2028-03-31', rent: '25.00', frequency: 'MONTHLY', due_day: '1', cycle_close_day: '28', next_due: '', waiver: '' },
  { lease: 'L-0115', tank: 'T-5108', tank_wc_gal: '500', owner: 'Sample Propane Co.', account: 'C-2212', site: 'Laundry, side yard', start: '2025-11-01', end: '2027-10-31', rent: '25.00', frequency: 'MONTHLY', due_day: '1', cycle_close_day: '28', next_due: '', waiver: '' },
  { lease: 'L-0119', tank: 'T-6110', tank_wc_gal: '250', owner: 'Sample Propane Co.', account: 'R-1046', site: 'Residence, backyard', start: '2026-01-15', end: '2029-01-14', rent: '96.00', frequency: 'ANNUAL', due_day: '15', cycle_close_day: '', next_due: '2027-01-15', waiver: '' },
]), REF_AT);

put('monthly/2026-09/cargas_lease_charges.csv', csv('#source=cargas_lease_charges;period=2026-09;generated=2026-09-30T21:00', ['charge_id', 'date', 'lease', 'account', 'amount', 'tax'], [
  { charge_id: 'LC-8901', date: '2026-09-01', lease: 'L-0108', account: 'C-2204', amount: '30.00', tax: '2.48' },
  { charge_id: 'LC-8902', date: '2026-09-01', lease: 'L-0112', account: 'C-2207', amount: '25.00', tax: '2.06' },
  { charge_id: 'LC-8903', date: '2026-09-01', lease: 'L-0115', account: 'C-2212', amount: '25.00', tax: '2.06' },
]), '2026-09-30T21:05');

// ---------- trucks and tickets ----------
// accounts used by planted cases or under contract never come out of the random draw
const RESERVED = new Set(['R-1031', 'R-1088', 'R-1123', 'R-1137', 'R-1027', 'R-1046']);
const resPool = RES.map((r) => r[0]).filter((a) => !RESERVED.has(a));
const drawRes = () => resPool.splice(Math.floor(rnd() * resPool.length), 1)[0]; // each residence delivered once in the week
const TRUCK_WC = 32000; const TRUCK_CAP = 26500; const RESERVE = 1000; // tenths: 3,200 gal tank, filled to about 85 %
put('reference/trucks.csv', csv('#source=trucks;period=reference;generated=2026-10-25T20:00', ['truck', 'meter_serial', 'tank_wc_gal', 'max_fill_pct'], [
  { truck: 'B-11', meter_serial: 'MTR-30117', tank_wc_gal: '3200', max_fill_pct: '85' }, { truck: 'B-12', meter_serial: 'MTR-30142', tank_wc_gal: '3200', max_fill_pct: '85' }, { truck: 'B-14', meter_serial: 'MTR-30163', tank_wc_gal: '3200', max_fill_pct: '85' },
]), REF_AT);
const TRUCKS = {
  'B-11': { serial: 'MTR-30117', no: 4410, counts: [9, 10, 9, 10, 9], tot: 12483305, com: 0, gauge: 8200, driver: 'Driver 3' },
  'B-12': { serial: 'MTR-30142', no: 5501, counts: [10, 10, 10, 10, 9], tot: 9877410, com: 0, gauge: 6400, driver: 'Driver 5' },
  'B-14': { serial: 'MTR-30163', no: 7681, counts: [9, 10, 9, 9, 9], tot: 15502226, com: 0.6, gauge: 9100, driver: 'Driver 8' },
};
// planted overrides: [truck, day, ticket_no] -> fields
const PLANT = {
  'B-14|2026-10-26|7684': { account: 'R-1137', net: 2600, contract: 'PB-118', price: 2399 },          // PreBuy price, must stay quiet
  'B-14|2026-10-27|7693': { account: 'C-2210', net: 1650 },                                            // 412.50 later mis-split in QBO
  'B-14|2026-10-27|7696': { account: 'C-2205', net: 3000, approval: 'AP-311', price: 2399 },         // approved discount, quiet
  'B-14|2026-10-27|7699': { lateTo: '2026-10-28' },                                                   // route still open, posted next morning
  'B-11|2026-10-27|4423': { account: 'R-1031', net: 1424, voidFirst: true },                         // voided then replaced: counts once
  'B-11|2026-10-28|4433': { account: 'R-1123', net: 1800, price: 2499 },                             // below plan, no contract
  'B-12|2026-10-29|5536': { account: 'R-1088', net: 2400, unposted: true },                          // missing from posted transactions
};
const VCF = (f) => 1 - 0.0015 * (f - 60); // used here only to print plausible gross gallons; the engine never corrects temperature

let txnId = 88001; let jeId = 5101; let depId = 7301; let payId = 40211;
const lateCarry = {}; // day -> [posted rows]
const STORAGE_WC = 30000;
let storage = 195000; // tenths, net at 60F, morning of Mon
const truckGauge = Object.fromEntries(Object.entries(TRUCKS).map(([k, v]) => [k, v.gauge]));
const zCount = {}; const DEPS = {};

DAYS.forEach((day, di) => {
  const N = NEXT[day]; const md = mmdd(day);
  const swing = day === '2026-10-26';
  const tempAt = (min) => Math.round(swing ? 46 + ((min - 450) / 640) * 40 : 55 + ((min - 450) / 640) * 18); // liquid in the truck follows the air
  const meterRows = []; const posted = []; const rackLoads = []; const truckClose = {};
  for (const [truck, T] of Object.entries(TRUCKS)) {
    const n = T.counts[di]; let minute = 465 + ri(0, 15);
    const planted = Object.keys(PLANT).filter((k) => k.startsWith(`${truck}|${day}|`)).map((k) => PLANT[k].account).filter(Boolean);
    const used = new Set(planted);
    const draw = () => { let a; if (rnd() < T.com) { do { a = pick(COM)[0]; } while (used.has(a)); } else a = drawRes(); used.add(a); return a; };
    let content = truckGauge[truck];
    const first = Math.floor((TRUCK_CAP - content - ri(0, 1500)) / 100) * 100;
    rackLoads.push({ time: `${day}T${hm(minute - 18)}`, truck, net_gal: gal(first), base: 'NET60', origin: 'RACK_METER' }); content += first;
    meterRows.push({ truck, record: 'SHIFT_START', ticket_no: '', time: hm(minute - 25), account: '', gross_gal: '', net_gal: '', temp_f: '', totalizer_gal: gal(T.tot), base: 'NET60', status: '' });
    for (let i = 0; i < n; i++) {
      let no = T.no++;
      if (truck === 'B-11' && day === '2026-10-30' && no === 4452) no = T.no++; // a ticket number that never reaches the register
      const key = `${truck}|${day}|${no}`; const pl = PLANT[key] || {};
      const account = pl.account || draw();
      const net = pl.net || (account.startsWith('C-') ? ri(1800, 5200) : ri(900, 3300));
      if (content - net < RESERVE) { // back to the plant for a second load, never above about 85 %
        const L = Math.floor((TRUCK_CAP - content) / 100) * 100;
        rackLoads.push({ time: `${day}T${hm(minute + 5)}`, truck, net_gal: gal(L), base: 'NET60', origin: 'RACK_METER' }); content += L; minute += 40;
      }
      const tf = tempAt(minute); const gross = Math.round(net / VCF(tf));
      T.tot += net; content -= net;
      meterRows.push({ truck, record: 'TICKET', ticket_no: no, time: hm(minute), account, gross_gal: gal(gross), net_gal: gal(net), temp_f: tf, totalizer_gal: gal(T.tot), base: 'NET60', status: 'PRINTED' });
      minute += ri(34, 56);
      if (pl.unposted) continue;
      const price = pl.price || planPrice(account, day);
      const row = { delivery_date: day, account, ticket_no: no, truck, product: 'PROPANE-BULK', net_gal: gal(net), unit_price: px(price), amount: usd(amt(net, price)), tax: '0.00', contract_ref: pl.contract || '', approval_ref: pl.approval || '', status: 'POSTED', replaces: '', _cents: amt(net, price), _net: net, _res: account.startsWith('R-') };
      if (pl.voidFirst) {
        const wrong = 2949; // the future price, entered by mistake and voided
        posted.push({ ...row, txn_id: txnId++, unit_price: px(wrong), amount: usd(amt(net, wrong)), status: 'VOID', _cents: amt(net, wrong) });
        posted.push({ ...row, txn_id: txnId++, replaces: posted[posted.length - 1].txn_id });
      } else if (pl.lateTo) {
        (lateCarry[pl.lateTo] ||= []).push({ ...row });
      } else posted.push({ ...row, txn_id: txnId++ });
    }
    if (truck === 'B-12' && day === '2026-10-27') { T.tot += 124; content -= 124; } // 12.4 gal through the meter with no ticket
    meterRows.push({ truck, record: 'SHIFT_END', ticket_no: '', time: hm(minute + 20), account: '', gross_gal: '', net_gal: '', temp_f: '', totalizer_gal: gal(T.tot), base: 'NET60', status: '' });
    truckClose[truck] = content;
  }
  for (const r of lateCarry[day] || []) posted.unshift({ ...r, txn_id: txnId++, _late: true });
  // posting times
  let pm = 17 * 60 + 52;
  for (const r of posted) { r.posted_at = r._late ? `${day}T07:55` : `${day}T${hm(pm)}`; if (!r._late) pm += ri(2, 5); r.gl_batch = `GL-${md}`; }
  put(`days/${day}/meter_register.csv`, csv(`#source=meter_register;period=${day};generated=${day}T18:35`, ['truck', 'record', 'ticket_no', 'time', 'account', 'gross_gal', 'net_gal', 'temp_f', 'totalizer_gal', 'base', 'status'], meterRows), `${day}T18:40`);
  put(`days/${day}/cargas_routes.csv`, csv(`#source=cargas_routes;period=${day};generated=${day}T21:00`, ['route_id', 'truck', 'driver', 'status', 'opened_at', 'closed_at'],
    Object.entries(TRUCKS).map(([truck, T]) => {
      const open = day === '2026-10-27' && truck === 'B-14';
      return { route_id: `RT-${truck.slice(2)}-${md}`, truck, driver: T.driver, status: open ? 'OPEN' : 'CLOSED', opened_at: `${day}T07:20`, closed_at: open ? '' : `${day}T${truck === 'B-12' ? '17:42' : truck === 'B-11' ? '17:18' : '17:31'}` };
    })), `${day}T21:05`);
  const pcols = ['txn_id', 'posted_at', 'delivery_date', 'account', 'ticket_no', 'truck', 'product', 'net_gal', 'unit_price', 'amount', 'tax', 'contract_ref', 'approval_ref', 'gl_batch', 'status', 'replaces'];
  const active = posted.filter((r) => r.status !== 'VOID');
  const trailer = `#trailer;rows=${posted.length};net_gal=${gal(active.reduce((a, r) => a + r._net, 0))};amount=${usd(active.reduce((a, r) => a + r._cents, 0))}`;
  const shown = day === '2026-10-30' ? posted.slice(0, 20) : posted; // Friday: export cut after 20 rows, trailer still announces all
  const postedText = csv(`#source=cargas_posted;period=${day};generated=${day}T21:00`, pcols, shown, trailer);
  put(`days/${day}/cargas_posted.csv`, postedText, `${day}T21:05`);
  if (day === '2026-10-27') put(`days/${day}/cargas_posted (1).csv`, postedText, `${N}T05:41`); // same file sent twice
  // GL distribution batch (assumed format) and its QBO JournalEntry
  const res = active.filter((r) => r._res).reduce((a, r) => a + r._cents, 0); const com = active.filter((r) => !r._res).reduce((a, r) => a + r._cents, 0);
  put(`days/${day}/cargas_gl_batch.json`, JSON.stringify({ source: 'cargas_gl_batch', period: day, generated: `${day}T21:08`, batch_id: `GL-${md}`, transactions: active.map((r) => r.txn_id),
    lines: [{ account: '1100', name: 'Accounts Receivable (A/R)', debit: usd(res + com), credit: '0.00' }, { account: '4010', name: 'Residential bulk propane sales', debit: '0.00', credit: usd(res) }, { account: '4020', name: 'Commercial bulk propane sales', debit: '0.00', credit: usd(com) }] }, null, 2) + '\n', `${day}T21:10`);
  const shift = day === '2026-10-27' ? 41250 : 0; // Tuesday: 412.50 credited to 4010 instead of 4020, journal still balanced
  const jeLine = (id, c, type, v, name) => ({ Id: String(id), Amount: Number(usd(c)), DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: type, AccountRef: { value: v, name } } });
  const je = { Id: String(jeId++), DocNumber: `GL-${md}`, TxnDate: day, PrivateNote: `Cargas GL distributions, batch GL-${md}`, Line: [jeLine(0, res + com, 'Debit', '1100', 'Accounts Receivable (A/R)'), jeLine(1, res + shift, 'Credit', '4010', 'Residential bulk propane sales'), jeLine(2, com - shift, 'Credit', '4020', 'Commercial bulk propane sales')] };
  const qboWrap = (source, entity, list, q) => JSON.stringify({ _export: { source, period: day, retrieved: `${N}T05:28`, query: q }, QueryResponse: { [entity]: list, startPosition: 1, maxResults: list.length, totalCount: list.length } }, null, 2) + '\n';
  put(`days/${day}/qbo_journalentries.json`, qboWrap('qbo_journalentries', 'JournalEntry', [je], `select * from JournalEntry where TxnDate = '${day}'`), `${N}T05:30`);

  // payments, deposits, settlement
  const pays = [];
  const thursday = day === '2026-10-29';
  const cardAmts = thursday ? [25000, 31000, 18500, 25500] : Array.from({ length: ri(3, 5) }, () => ri(90, 520) * 100 + pick([0, 0, 50, 25]));
  const checkAmts = Array.from({ length: ri(2, 4) }, () => ri(120, 900) * 100 + pick([0, 0, 50]));
  const accts = [...RES.map((r) => r[0]), ...COM.map((c) => c[0])];
  cardAmts.forEach((c) => pays.push({ pay_id: `P-${payId++}`, date: day, account: pick(accts), method: 'CARD', amount: usd(c), reference: `auth ${ri(100000, 999999)}`, deposit_id: `CD-${md}-CARD`, _c: c }));
  checkAmts.forEach((c) => pays.push({ pay_id: `P-${payId++}`, date: day, account: pick(accts), method: 'CHECK', amount: usd(c), reference: `check ${ri(1000, 9999)}`, deposit_id: `CD-${md}-CHK`, _c: c }));
  const sumOf = (m) => pays.filter((p) => p.method === m).reduce((a, p) => a + p._c, 0);
  put(`days/${day}/cargas_payments.csv`, csv(`#source=cargas_payments;period=${day};generated=${day}T21:00`, ['pay_id', 'date', 'account', 'method', 'amount', 'reference', 'deposit_id'], pays, `#trailer;rows=${pays.length};amount=${usd(pays.reduce((a, p) => a + p._c, 0))}`), `${day}T21:05`);
  const deps = [{ deposit_id: `CD-${md}-CARD`, date: day, method: 'CARD', payments: cardAmts.length, amount: usd(sumOf('CARD')) }, { deposit_id: `CD-${md}-CHK`, date: day, method: 'CHECK', payments: checkAmts.length, amount: usd(sumOf('CHECK')) }];
  DEPS[day] = deps;
  if (day === '2026-10-28') {
    // Wednesday: the deposit export received this morning is Monday's again (wrong period selected in the saved query)
    put(`days/${day}/cargas_deposits.csv`, csv('#source=cargas_deposits;period=2026-10-26;generated=2026-10-29T05:05', ['deposit_id', 'date', 'method', 'payments', 'amount'], DEPS['2026-10-26']), `${N}T05:10`);
  } else put(`days/${day}/cargas_deposits.csv`, csv(`#source=cargas_deposits;period=${day};generated=${day}T21:00`, ['deposit_id', 'date', 'method', 'payments', 'amount'], deps), `${day}T21:05`);

  // POS counter sales
  const ITEMS = [['EXCH20', '20 lb cylinder exchange', 2199, 0, 1], ['EXCH20', '20 lb cylinder exchange', 2199, 0, 1], ['EXCH33', '33.5 lb forklift cylinder exchange', 3650, 0, 1], ['FILL', 'Cylinder refill, gallons', 3490, 0, 0], ['ACC-HOSE', 'Hose and regulator', 1800, 149, 1], ['ACC-ADPT', 'Tank adapter', 950, 78, 1]];
  const posRows = []; let minute = 7 * 60 + ri(2, 9); let rc = 1;
  const nRec = ri(24, 32);
  for (let i = 0; i < nRec; i++) {
    const tender = rnd() < 0.45 ? 'CASH' : 'CARD'; const lines = rnd() < 0.25 ? 2 : 1; const rid = `${md}-${String(rc++).padStart(3, '0')}`;
    for (let l = 0; l < lines; l++) {
      const it = pick(ITEMS); let qty; let a; let t;
      if (it[0] === 'FILL') { const q = ri(28, 52); qty = gal(q); a = amt(q, it[2]); t = 0; } // gallons x price per gallon
      else { const n = it[0].startsWith('EXCH') ? ri(1, 3) : 1; qty = String(n); a = n * it[2]; t = n * it[3]; }
      posRows.push({ receipt: rid, time: hm(minute), type: 'SALE', item: it[0], description: it[1], qty, unit_price: it[0] === 'FILL' ? px(it[2]) : usd(it[2]), amount: usd(a), tax: usd(t), tender, account: '', _a: a, _t: t });
    }
    minute += ri(12, 30); if (minute > 17 * 60 + 50) break;
    if ((day === '2026-10-26' && i === 9) || (thursday && posRows.length && minute > 15 * 60 + 10 && !posRows.some((r) => r.type === 'PAYMENT_ON_ACCOUNT'))) {
      const rid2 = `${md}-${String(rc++).padStart(3, '0')}`;
      posRows.push({ receipt: rid2, time: hm(minute), type: 'PAYMENT_ON_ACCOUNT', item: 'POA', description: 'Payment on account', qty: '1', unit_price: '150.00', amount: '150.00', tax: '0.00', tender: thursday ? 'CARD' : 'CASH', account: thursday ? 'C-2209' : 'C-2203', _a: 15000, _t: 0 });
      minute += ri(10, 20);
    }
  }
  const closeAt = '18:04';
  const sales = posRows.filter((r) => r.type === 'SALE');
  const z = { register: 'R1', business_day: day, z_number: `Z-${md}`, opened: '07:00', closed: closeAt, receipts: new Set(posRows.map((r) => r.receipt)).size,
    sales_total: usd(sales.reduce((a, r) => a + r._a, 0)), tax_total: usd(sales.reduce((a, r) => a + r._t, 0)), payments_on_account: usd(posRows.filter((r) => r.type !== 'SALE').reduce((a, r) => a + r._a, 0)),
    tender_cash: usd(posRows.filter((r) => r.tender === 'CASH').reduce((a, r) => a + r._a + r._t, 0)), tender_card: usd(posRows.filter((r) => r.tender === 'CARD').reduce((a, r) => a + r._a + r._t, 0)) };
  zCount[day] = z;
  const pcols2 = ['receipt', 'time', 'type', 'item', 'description', 'qty', 'unit_price', 'amount', 'tax', 'tender', 'account'];
  const posFull = csv(`#source=pos_sales;period=${day};from=07:00;to=${closeAt};generated=${day}T18:06`, pcols2, posRows, `#trailer;rows=${posRows.length};receipts=${z.receipts};amount=${usd(posRows.reduce((a, r) => a + r._a + r._t, 0))}`);
  const posClose = csv(`#source=pos_close;period=${day};generated=${day}T18:06`, ['register', 'business_day', 'z_number', 'opened', 'closed', 'receipts', 'sales_total', 'tax_total', 'payments_on_account', 'tender_cash', 'tender_card'], [z]);
  if (thursday) {
    const part = posRows.filter((r) => r.time <= '13:12');
    put(`days/${day}/pos_sales_intraday.csv`, csv(`#source=pos_sales;period=${day};from=07:00;to=13:12;generated=${day}T13:13`, pcols2, part), `${day}T13:15`);
    put(`days/${day}/pos_sales.csv`, posFull, `${N}T09:40`);
    put(`days/${day}/pos_close.csv`, posClose, `${N}T09:40`);
  } else {
    put(`days/${day}/pos_sales.csv`, posFull, `${day}T18:10`);
    put(`days/${day}/pos_close.csv`, posClose, `${day}T18:10`);
  }

  // processor settlement (received next morning)
  const ofcGross = sumOf('CARD'); const ofcFee = thursday ? 3000 : Math.round(ofcGross * 0.029) + 30 * cardAmts.length;
  const ctrGross = Math.round(Number(z.tender_card) * 100); const ctrFee = Math.round(ctrGross * 0.027) + 25;
  const st = [{ record: 'BATCH', batch: `OFC-${md}`, ref: `office terminal, ${cardAmts.length} payments`, gross: usd(ofcGross), fee: usd(ofcFee), adjustment: '0.00', net: usd(ofcGross - ofcFee) },
    ...pays.filter((p) => p.method === 'CARD').map((p) => ({ record: 'ITEM', batch: `OFC-${md}`, ref: p.pay_id, gross: p.amount, fee: '', adjustment: '', net: '' })),
    { record: 'BATCH', batch: `CTR-${md}`, ref: 'counter terminal R1', gross: usd(ctrGross), fee: usd(ctrFee), adjustment: '0.00', net: usd(ctrGross - ctrFee) },
    { record: 'ITEM', batch: `CTR-${md}`, ref: `Z-${md}`, gross: usd(ctrGross), fee: '', adjustment: '', net: '' }];
  put(`days/${day}/processor_settlement.csv`, csv(`#source=processor_settlement;period=${day};generated=${N}T04:25`, ['record', 'batch', 'ref', 'gross', 'fee', 'adjustment', 'net'], st), `${N}T04:30`);

  // QBO deposits
  const dl = (c, v, name, desc) => ({ Amount: Number(usd(c)), DetailType: 'DepositLineDetail', ...(desc ? { Description: desc } : {}), DepositLineDetail: { AccountRef: { value: v, name } } });
  const bank = { value: '1010', name: 'Operating bank account' };
  const cashC = Math.round(Number(z.tender_cash) * 100) - (thursday ? 12000 : 0);
  const qdeps = [
    { Id: String(depId++), TxnDate: day, DocNumber: `CD-${md}-CARD`, PrivateNote: `Cargas deposit CD-${md}-CARD`, DepositToAccountRef: bank, TotalAmt: Number(usd(ofcGross - ofcFee)), Line: [dl(ofcGross, '1150', 'Cargas clearing'), dl(-ofcFee, '6120', 'Merchant fees', `Processor fees, batch OFC-${md}`)] },
    { Id: String(depId++), TxnDate: day, DocNumber: `CD-${md}-CHK`, PrivateNote: `Cargas deposit CD-${md}-CHK`, DepositToAccountRef: bank, TotalAmt: Number(usd(sumOf('CHECK'))), Line: [dl(sumOf('CHECK'), '1150', 'Cargas clearing')] },
    { Id: String(depId++), TxnDate: day, DocNumber: `Z-${md}-CASH`, PrivateNote: `POS close Z-${md}, cash`, DepositToAccountRef: bank, TotalAmt: Number(usd(cashC)), Line: [dl(cashC, '1160', 'POS clearing')] },
    { Id: String(depId++), TxnDate: day, DocNumber: `Z-${md}-CARD`, PrivateNote: `POS close Z-${md}, card`, DepositToAccountRef: bank, TotalAmt: Number(usd(ctrGross - ctrFee)), Line: [dl(ctrGross, '1160', 'POS clearing'), dl(-ctrFee, '6120', 'Merchant fees', `Processor fees, batch CTR-${md}`)] },
  ];
  put(`days/${day}/qbo_deposits.json`, qboWrap('qbo_deposits', 'Deposit', qdeps, `select * from Deposit where TxnDate = '${day}'`), `${N}T05:30`);

  // bulk perimeter: storage tank + trucks
  const gaugeRows = []; const rack = rackLoads.sort((a, b) => a.time.localeCompare(b.time)); const receipts = []; const fills = [];
  const g = (time, vessel, net, tf, wc) => ({ time: `${day}T${time}`, vessel, reading_pct: ((net / 10 / VCF(tf)) / wc * 100).toFixed(1), liquid_temp_f: tf, net_gal: gal(net), base: 'NET60', origin: 'GAUGE' });
  const sOpen = swing ? 54 : 58; const sClose = swing ? 61 : 62; // 30,000 gal of liquid warms slowly
  const tOpen = swing ? 46 : 56; const tClose = swing ? 84 : 66; // truck tanks follow the air
  gaugeRows.push(g('05:30', 'STORAGE-1', storage, sOpen, STORAGE_WC));
  for (const t of Object.keys(TRUCKS)) gaugeRows.push(g('05:35', t, truckGauge[t], tOpen, TRUCK_WC / 10));
  const bol = { '2026-10-26': ['BOL-4471', 91800, '07:10'], '2026-10-28': ['BOL-4502', 92400, '06:55'], '2026-10-30': ['BOL-4529', 92000, '07:20'] }[day];
  if (bol) { receipts.push({ bol: bol[0], time: `${day}T${bol[2]}`, carrier: 'Transport carrier (fictional)', net_gal: gal(bol[1]), base: 'NET60', origin: 'BOL' }); storage += bol[1]; }
  for (const r of rack) storage -= tenths(r.net_gal);
  for (const t of Object.keys(TRUCKS)) truckGauge[t] = truckClose[t] + (day === '2026-10-28' ? 0 : ri(-60, 60));
  const n20 = ri(28, 44); const n33 = ri(8, 16); const dock = n20 * 47 + n33 * 80 + ri(-5, 5);
  fills.push({ time: `${day}T16:40`, cylinders_20lb: n20, cylinders_33lb: n33, net_gal: gal(dock), base: 'NET60', origin: 'DOCK_METER' });
  storage -= dock; storage += day === '2026-10-28' ? -8200 : ri(-250, 250);
  gaugeRows.push(g('18:30', 'STORAGE-1', storage, sClose, STORAGE_WC));
  for (const t of Object.keys(TRUCKS)) gaugeRows.push(g('18:35', t, truckGauge[t], tClose, TRUCK_WC / 10));
  if (day === '2026-10-30') { const s = gaugeRows.find((r) => r.vessel === 'STORAGE-1' && r.time.endsWith('18:30')); s.liquid_temp_f = ''; s.net_gal = ''; s.base = 'UNKNOWN'; }
  const gcols = ['time', 'vessel', 'reading_pct', 'liquid_temp_f', 'net_gal', 'base', 'origin'];
  put(`days/${day}/gauge_sheet.csv`, csv(`#source=gauge_sheet;period=${day};generated=${day}T18:40`, gcols, gaugeRows), `${day}T18:45`);
  put(`days/${day}/transport_receipts.csv`, csv(`#source=transport_receipts;period=${day};generated=${day}T18:40`, ['bol', 'time', 'carrier', 'net_gal', 'base', 'origin'], receipts), `${day}T18:45`);
  put(`days/${day}/loading_rack.csv`, csv(`#source=loading_rack;period=${day};generated=${day}T18:40`, ['time', 'truck', 'net_gal', 'base', 'origin'], rack), `${day}T18:45`);
  put(`days/${day}/dock_fills.csv`, csv(`#source=dock_fills;period=${day};generated=${day}T18:40`, ['time', 'cylinders_20lb', 'cylinders_33lb', 'net_gal', 'base', 'origin'], fills), `${day}T18:45`);

  // lease charges, month to date (L-0112 never billed in October)
  put(`days/${day}/cargas_lease_charges.csv`, csv(`#source=cargas_lease_charges;period=2026-10;generated=${day}T21:00`, ['charge_id', 'date', 'lease', 'account', 'amount', 'tax'], [
    { charge_id: 'LC-9001', date: '2026-10-01', lease: 'L-0108', account: 'C-2204', amount: '30.00', tax: '2.48' },
    { charge_id: 'LC-9002', date: '2026-10-01', lease: 'L-0115', account: 'C-2212', amount: '25.00', tax: '2.06' },
  ]), `${day}T21:05`);

  // Thursday: cylinder route to dealer cages (consignment: cylinders stay ours until the dealer sells them)
  if (thursday) {
    put(`days/${day}/cylinder_movements.csv`, csv(`#source=cylinder_movements;period=${day};since=2026-10-22;generated=${day}T18:00`, ['date', 'dealer', 'movement', 'qty', 'ref'], [
      { date: '2026-10-23..2026-10-29', dealer: 'D-07', movement: 'DEALER_EXCHANGE', qty: 8, ref: 'Dealer sales report DSR-07-1029' },
      { date: '2026-10-23..2026-10-29', dealer: 'D-07', movement: 'DEALER_SOLD_NO_RETURN', qty: 2, ref: 'Dealer sales report DSR-07-1029' },
      { date: '2026-10-29', dealer: 'D-07', movement: 'DELIVERED_FULL', qty: 12, ref: 'Cylinder route C-21, stop 4' },
      { date: '2026-10-29', dealer: 'D-07', movement: 'PICKED_EMPTY', qty: 8, ref: 'Cylinder route C-21, stop 4' },
      { date: '2026-10-23..2026-10-29', dealer: 'D-03', movement: 'DEALER_EXCHANGE', qty: 9, ref: 'Dealer sales report DSR-03-1029' },
      { date: '2026-10-23..2026-10-29', dealer: 'D-03', movement: 'DEALER_SOLD_NO_RETURN', qty: 1, ref: 'Dealer sales report DSR-03-1029' },
      { date: '2026-10-29', dealer: 'D-03', movement: 'DELIVERED_FULL', qty: 10, ref: 'Cylinder route C-21, stop 2' },
      { date: '2026-10-29', dealer: 'D-03', movement: 'PICKED_EMPTY', qty: 9, ref: 'Cylinder route C-21, stop 2' },
    ]), `${day}T18:05`);
    put(`days/${day}/cage_counts.csv`, csv(`#source=cage_counts;period=${day};generated=${day}T18:00`, ['date', 'dealer', 'cage', 'full', 'empty', 'counted_by', 'ref'], [
      { date: '2026-10-22', dealer: 'D-07', cage: 'CG-07A', full: 20, empty: 0, counted_by: 'Driver 11', ref: 'Count after delivery, route C-21' },
      { date: '2026-10-22', dealer: 'D-03', cage: 'CG-03A', full: 16, empty: 0, counted_by: 'Driver 11', ref: 'Count after delivery, route C-21' },
      { date: '2026-10-29', dealer: 'D-07', cage: 'CG-07A', full: 21, empty: 0, counted_by: 'Driver 11', ref: 'Count after delivery, route C-21, stop 4' },
      { date: '2026-10-29', dealer: 'D-03', cage: 'CG-03A', full: 16, empty: 0, counted_by: 'Driver 11', ref: 'Count after delivery, route C-21, stop 2' },
    ]), `${day}T18:05`);
  }
});

writeFileSync(ROOT + 'manifest.json', JSON.stringify({ note: 'Fictional files and the time each one was received. Every name and number is invented.', files: manifest }, null, 2) + '\n');
console.log(`fixtures: ${manifest.length} files`);
