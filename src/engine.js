// The morning run: take the files received by the run time, decide which ones can be used for the
// business day, run every rule whose sources are usable, and assemble the report. Same code in Node
// (tests) and in the browser (the demo page). No network, no model call.
import { parseFile } from './parse.js';
import { RULES, DATA_RULES } from './rules.js';
import { buildSummary } from './summary.js';
import { tenths, cents, fmtUsd, fmtGal, fmtDay, fmtStamp, addDays, sum } from './util.js';

export const SOURCES = {
  meter_register: { label: 'Truck meter registers', system: 'Truck meters', kind: 'daily' },
  cargas_routes: { label: 'Routes', system: 'Cargas Energy', kind: 'daily' },
  cargas_posted: { label: 'Posted transactions', system: 'Cargas Energy', kind: 'daily', trailer: true },
  cargas_payments: { label: 'Customer payments', system: 'Cargas Energy', kind: 'daily', trailer: true },
  cargas_deposits: { label: 'Deposits', system: 'Cargas Energy', kind: 'daily' },
  cargas_gl_batch: { label: 'GL distribution batch', system: 'Cargas Energy', kind: 'daily' },
  cargas_lease_charges: { label: 'Lease charges, month to date', system: 'Cargas Energy', kind: 'monthly' },
  qbo_journalentries: { label: 'JournalEntry query', system: 'QuickBooks Online', kind: 'daily' },
  qbo_deposits: { label: 'Deposit query', system: 'QuickBooks Online', kind: 'daily' },
  processor_settlement: { label: 'Card settlement', system: 'Card processor', kind: 'daily' },
  pos_sales: { label: 'Counter sales export', system: 'POS', kind: 'daily', trailer: true, family: 'pos' },
  pos_close: { label: 'Register close', system: 'POS', kind: 'daily', family: 'pos' },
  gauge_sheet: { label: 'Gauge sheet', system: 'Plant', kind: 'daily' },
  transport_receipts: { label: 'Transport receipts', system: 'Plant', kind: 'daily' },
  loading_rack: { label: 'Loading rack', system: 'Plant', kind: 'daily' },
  dock_fills: { label: 'Cylinder dock fills', system: 'Plant', kind: 'daily' },
  cylinder_movements: { label: 'Cylinder movements', system: 'Cylinder route', kind: 'event' },
  cage_counts: { label: 'Cage counts', system: 'Cylinder route', kind: 'event' },
  customers: { label: 'Customers', system: 'Cargas Energy', kind: 'reference' },
  price_plans: { label: 'Price plans', system: 'Cargas Energy', kind: 'reference' },
  prebuy_contracts: { label: 'PreBuy contracts', system: 'Cargas Energy', kind: 'reference' },
  approvals: { label: 'Price approvals', system: 'Office', kind: 'reference' },
  leases: { label: 'Tank leases', system: 'Office', kind: 'reference' },
};

export const QUAL = {
  billing_to_verify: 'billing to verify', accounting_difference: 'accounting difference', settlement_pending: 'settlement pending',
  quantity_to_confirm: 'quantity to confirm', explained: 'explained', not_concluded: 'not concluded',
};
const QUAL_ORDER = ['billing_to_verify', 'accounting_difference', 'settlement_pending', 'quantity_to_confirm'];

export function prepare(list) {
  return list.map((f) => parseFile(f.path, f.text, f.received_at)).sort((a, b) => a.received_at.localeCompare(b.received_at) || a.path.localeCompare(b.path));
}

function trailerCheck(f, name) {
  if (!f.trailer) return { status: 'unverified', detail: 'no control trailer: completeness not established' };
  const t = f.trailer; const n = f.rows.length;
  if (Number(t.rows) !== n) return { status: 'incomplete', detail: `${n} of the ${t.rows} rows its trailer announces`, received_rows: n, announced_rows: Number(t.rows) };
  if (name === 'cargas_posted') {
    const act = f.rows.filter((r) => r.status !== 'VOID');
    if (cents(t.amount) !== sum(act, (r) => cents(r.amount)) || tenths(t.net_gal) !== sum(act, (r) => tenths(r.net_gal))) return { status: 'incomplete', detail: 'control totals differ from the rows' };
  } else if (name === 'pos_sales') {
    if (cents(t.amount) !== sum(f.rows, (r) => cents(r.amount) + cents(r.tax)) || Number(t.receipts) !== new Set(f.rows.map((r) => r.receipt)).size) return { status: 'incomplete', detail: 'control totals differ from the rows' };
  } else if (t.amount !== undefined && cents(t.amount) !== sum(f.rows, (r) => cents(r.amount))) return { status: 'incomplete', detail: 'control totals differ from the rows' };
  return { status: 'ok' };
}

export function runDay(files, day, opts = {}) {
  const runAt = `${addDays(day, 1)}T06:00`; const windowStart = `${day}T06:00`;
  const closes = files.filter((f) => f.meta.source === 'pos_close' && f.meta.period === day);
  const closeOnTime = closes.some((f) => f.received_at <= runAt);
  const posClose = opts.posClose || (closeOnTime ? 'received' : 'missing');
  let cutoff = runAt; let rerunAt = null;
  if (posClose === 'received' && !closeOnTime && closes.length) {
    const late = closes.map((f) => f.received_at).sort()[0];
    const [h, m] = late.slice(11, 16).split(':').map(Number); const t = h * 60 + m + 5;
    rerunAt = `${late.slice(0, 11)}${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; cutoff = rerunAt;
  }
  const withheld = (f) => posClose === 'missing' && f.meta.source === 'pos_close' && f.meta.period === day;

  // 1. which files can be used
  const fileLog = []; const seen = new Map(); const usable = [];
  for (const f of files) {
    if (f.received_at > cutoff) { if (f.meta.period === day && f.received_at <= `${addDays(day, 2)}T06:00`) fileLog.push({ path: f.path, source: f.meta.source, received_at: f.received_at, status: 'after_run', detail: `arrived ${fmtStamp(f.received_at)}, after this run` }); continue; }
    if (withheld(f)) { fileLog.push({ path: f.path, source: f.meta.source, received_at: f.received_at, status: 'withheld', detail: 'left out to show the report without the register close' }); continue; }
    if (seen.has(f.hash)) { if (f.received_at > windowStart) fileLog.push({ path: f.path, source: f.meta.source, received_at: f.received_at, status: 'duplicate', detail: `same content as ${seen.get(f.hash).path}, received ${fmtStamp(seen.get(f.hash).received_at)}: ignored` }); continue; }
    seen.set(f.hash, f); usable.push(f);
  }
  const chosen = {}; const status = {};
  for (const [name, def] of Object.entries(SOURCES)) {
    let cands;
    if (def.kind === 'daily') {
      // files received since the last run; one covering the day wins, otherwise the latest one is judged (and found stale)
      // a file for an earlier day that never had one before its own run is a late arrival for that day, not a stale export for this one
      const lateFor = (f) => f.meta.period < day && !usable.some((g) => g !== f && g.meta.source === f.meta.source && g.meta.period === f.meta.period && g.received_at <= `${addDays(f.meta.period, 1)}T06:00`);
      const win = usable.filter((f) => f.meta.source === name && f.received_at > windowStart && !lateFor(f));
      const forDay = win.filter((f) => f.meta.period === day);
      cands = forDay.length ? forDay : win.slice(-1);
    }
    else if (def.kind === 'monthly') cands = usable.filter((f) => f.meta.source === name && f.meta.period === day.slice(0, 7));
    else if (def.kind === 'event') cands = usable.filter((f) => f.meta.source === name && f.meta.period === day);
    else cands = usable.filter((f) => f.meta.source === name);
    const pick = cands[cands.length - 1];
    for (const f of cands.slice(0, -1)) if (f.received_at > windowStart) fileLog.push({ path: f.path, source: name, received_at: f.received_at, status: 'replaced', detail: `replaced by ${pick.path}, received ${fmtStamp(pick.received_at)}` });
    chosen[name] = pick || null;
    if (!pick) { status[name] = def.kind === 'event' ? { status: 'none' } : { status: 'missing', detail: 'not received by the run' }; continue; }
    if (def.kind === 'daily' && pick.meta.period !== day) { status[name] = { status: 'stale', detail: `received ${fmtStamp(pick.received_at)} but covers ${fmtDay(pick.meta.period)}`, covers: pick.meta.period }; continue; }
    if (def.kind === 'monthly' && (pick.meta.generated || '').slice(0, 10) < day) { status[name] = { status: 'stale', detail: `generated ${fmtStamp(pick.meta.generated)}, before the day audited` }; continue; }
    if (pick.error) { status[name] = { status: 'incomplete', detail: pick.error }; continue; }
    if (pick.control && pick.control.announced !== pick.control.received) { status[name] = { status: 'incomplete', detail: `${pick.control.received} of ${pick.control.announced} records` }; continue; }
    status[name] = def.trailer ? trailerCheck(pick, name) : { status: 'ok' };
  }
  // the POS export is complete only against its register close
  const ps = chosen.pos_sales; const pc = status.pos_close.status === 'ok' ? chosen.pos_close.rows[0] : null;
  if (ps && status.pos_sales.status !== 'stale') {
    const to = ps.meta.to; const from = ps.meta.from;
    if (!pc) status.pos_sales = { status: 'unverified', detail: `export covers ${from} to ${to}; no register close to show the day is complete`, from, to };
    else if (to < pc.closed) status.pos_sales = { status: 'incomplete', detail: `export ends ${to}, register closed ${pc.closed}`, from, to };
    else if (status.pos_sales.status === 'ok' && new Set(ps.rows.map((r) => r.receipt)).size !== Number(pc.receipts)) status.pos_sales = { status: 'incomplete', detail: 'receipt count differs from the register close', from, to };
    else status.pos_sales = { ...status.pos_sales, from, to };
  }
  for (const [name, s] of Object.entries(status)) if (chosen[name]) { s.file = chosen[name].path; s.received_at = chosen[name].received_at; s.period = chosen[name].meta.period; }

  // 2. context for the rules
  const ok = (n) => status[n]?.status === 'ok';
  const custMap = new Map((chosen.customers?.rows || []).map((r) => [r.account, r]));
  const ctx = {
    day, runAt: cutoff,
    src: (n) => chosen[n], srcIfOk: (n) => (ok(n) ? chosen[n] : null),
    ref: (n) => chosen[n]?.rows || [], refFile: (n) => chosen[n],
    customer: (a) => custMap.get(a),
    register: (date) => (date === day ? chosen.meter_register : [...usable].reverse().find((f) => f.meta.source === 'meter_register' && f.meta.period === date)),
    previous: (n) => [...usable].reverse().find((f) => f.meta.source === n && f.meta.period < day) || null,
  };

  // 3. run the rules
  const lines = [];
  for (const rule of RULES) {
    const st = rule.sources.map((n) => [n, status[n]?.status]);
    if (rule.optional && st.some(([, s]) => s === 'none')) continue;
    const blocked = st.filter(([, s]) => s !== 'ok').map(([n]) => n);
    if (blocked.length) { lines.push({ rule: rule.id, scope: 'all', status: 'suspended', cause: 'source', blockedBy: blocked }); continue; }
    let out;
    try { out = rule.run(ctx); } catch (e) { out = [{ scope: 'all', status: 'suspended', cause: 'error', headline: `${rule.title}: could not run (${e.message})` }]; }
    for (const l of out) lines.push({ rule: rule.id, ...l });
  }

  // 4. data dossiers: one per family of unusable sources, listing the checks they stop
  const bad = Object.entries(status).filter(([n, s]) => ['missing', 'stale', 'incomplete', 'unverified'].includes(s.status) && SOURCES[n].kind !== 'reference');
  const groups = {};
  for (const [n, s] of bad) (groups[SOURCES[n].family || n] ||= []).push([n, s]);
  const dataDossiers = Object.entries(groups).map(([fam, members]) => {
    const names = members.map(([n]) => n);
    const stopped = lines.filter((l) => l.status === 'suspended' && l.cause === 'source' && l.blockedBy.some((b) => names.includes(b))).map((l) => l.rule);
    const f = (n) => chosen[n];
    if (fam === 'pos') {
      const sales = f('pos_sales'); const partial = sales ? sum(sales.rows.filter((r) => r.type === 'SALE'), (r) => cents(r.amount)) : 0;
      const close = status.pos_close; const st = status.pos_sales;
      const reason = close.status !== 'ok' ? `no register close${posClose === 'missing' && !closeOnTime ? ' received by 06:00' : ''}` : st.detail;
      return {
        rule: 'POS_COMPLETENESS', scope: 'pos', status: 'suspended', cause: 'data', qualification: 'not_concluded', suspends: stopped,
        headline: sales ? `POS export covers ${st.from} to ${st.to}, ${reason}: counter totals partial` : 'No POS export received: counter totals unavailable',
        action: 'Get the register close (or re-send the end-of-day export); the run picks it up and the suspended checks conclude.',
        fields: { from: st.from || '', to: st.to || '', partial: fmtUsd(partial), n: String(stopped.length), period: fmtDay(day), received: sales ? fmtStamp(sales.received_at) : '' },
        calc: [['Counter sales export', sales ? `${sales.path}, ${st.from} to ${st.to}, received ${fmtStamp(sales.received_at)}` : 'not received'], ['Control trailer', sales?.trailer ? 'present' : 'none'], ['Register close', close.status === 'ok' ? 'received' : 'not received', true], ['Counter sales so far (before tax)', fmtUsd(partial)], ['Checks suspended', stopped.join(', ') || 'none', true]],
        evidence: [
          ...(sales ? [{ system: 'POS (assumed export)', style: 'sheet', title: `Counter sales export, last receipts`, file: sales.path, received_at: sales.received_at, columns: ['Receipt', 'Time', 'Item', 'Amount', 'Tax', 'Tender'],
            rows: [...sales.rows.slice(-5).map((x) => ({ cells: [x.receipt, x.time, x.description, x.amount, x.tax, x.tender] })), ...(sales.trailer ? [] : [{ cells: ['', '', 'no control trailer after this row', '', '', ''], mark: 'ghost' }])],
            foot: [['Period in the file', `${sales.meta.period}, ${st.from} to ${st.to}`], ['Rows received', String(sales.rows.length)]] }] : []),
          { system: 'POS (assumed export)', style: 'tape', title: 'Register close', file: close.status === 'ok' ? chosen.pos_close.path : 'pos_close.csv', received_at: close.status === 'ok' ? chosen.pos_close.received_at : '', columns: ['Field', 'Value'],
            rows: close.status === 'ok' ? [{ cells: ['Closed', chosen.pos_close.rows[0].closed] }] : [{ cells: ['Z report', posClose === 'missing' && closeOnTime ? 'left out of this run' : 'not received by the run'], mark: 'ghost' }, { cells: ['Cash, card, receipts', 'unknown'], mark: 'ghost' }] },
        ],
      };
    }
    const [n, s] = members[0]; const file = f(n); const label = `${SOURCES[n].system} ${SOURCES[n].label.toLowerCase()}`;
    const fields = { source: label, n: String(stopped.length), period: fmtDay(day) };
    let headline;
    if (s.status === 'stale') { headline = `${label}: the file received covers ${fmtDay(s.covers || file.meta.period)}, not ${fmtDay(day)}`; Object.assign(fields, { covers: fmtDay(s.covers || file.meta.period), received: fmtStamp(file.received_at) }); }
    else if (s.status === 'incomplete' && s.announced_rows) { headline = `${label}: ${s.received_rows} of ${s.announced_rows} rows received`; Object.assign(fields, { rows: String(s.received_rows), announced: String(s.announced_rows) }); }
    else headline = `${label}: ${s.status === 'missing' ? 'not received' : s.detail}`;
    return {
      rule: 'SOURCE_FRESH_COMPLETE', scope: n, status: 'suspended', cause: 'data', qualification: 'not_concluded', sourceStatus: s.status, suspends: stopped, headline,
      action: s.status === 'stale' ? 'Re-run the saved export for the right day; the deposit checks run again on the next pass.' : 'Re-send the export; nothing from this file is counted until it is complete.',
      fields,
      calc: [['File', file ? file.path : 'none'], ['Received', file ? fmtStamp(file.received_at) : ''], ['Period in the file', file?.meta.period || ''], ['Business day audited', day], ['Status', s.detail || s.status, true], ['Checks suspended', stopped.join(', ') || 'none', true]],
      evidence: file ? [{ system: `${SOURCES[n].system}${SOURCES[n].system === 'Cargas Energy' ? ' (assumed export)' : ''}`, style: 'sheet', title: `${SOURCES[n].label}: header and trailer`, file: file.path, received_at: file.received_at, columns: ['Field', 'Value'],
        rows: [['First line', file.text.split('\n')[0]], ['Rows received', String(file.rows.length)], ['Last line', file.trailer ? file.text.trim().split('\n').pop() : 'no trailer']].map((c, i) => ({ cells: c, mark: (s.status === 'stale' && i === 0) || (s.status === 'incomplete' && i > 0) ? 'hit' : null })), foot: [] }] : [],
    };
  });

  // 5. dossiers, in three columns, lettered in order
  const ruleDef = Object.fromEntries([...RULES, ...Object.values(DATA_RULES)].map((r) => [r.id, r]));
  const person = lines.filter((l) => l.status === 'flag').sort((a, b) => QUAL_ORDER.indexOf(a.qualification) - QUAL_ORDER.indexOf(b.qualification) || (b.amount || 0) - (a.amount || 0));
  const cannot = [...dataDossiers, ...lines.filter((l) => l.status === 'pending' || (l.status === 'suspended' && l.cause !== 'source'))];
  const explained = lines.filter((l) => l.status === 'explained');
  const dossiers = [];
  const add = (l, column) => { const id = String.fromCharCode(65 + dossiers.length); const r = ruleDef[l.rule]; dossiers.push({ id, column, ...l, qualificationLabel: QUAL[l.qualification], ruleTitle: r.title, rulePlain: r.plain, ruleFormula: r.formula, ruleSources: r.sources || [], fields: { ...(l.fields || {}), qualification: QUAL[l.qualification] } }); };
  person.forEach((l) => add(l, 'person')); cannot.forEach((l) => add(l, 'cannot')); explained.forEach((l) => add(l, 'explained'));

  // 6. figures of the day, each with its basis and status
  const meterOk = status.meter_register.status === 'ok'; const postedOk = status.cargas_posted.status === 'ok';
  const delivered = meterOk ? sum(chosen.meter_register.rows.filter((r) => r.record === 'TICKET' && r.status !== 'VOID'), (r) => tenths(r.net_gal)) : null;
  const act = postedOk ? chosen.cargas_posted.rows.filter((r) => r.status !== 'VOID') : [];
  const sales = chosen.pos_sales; const posState = status.pos_sales.status;
  const counter = sales ? sum(sales.rows.filter((r) => r.type === 'SALE'), (r) => cents(r.amount)) : null;
  const poa = sales ? sum(sales.rows.filter((r) => r.type === 'PAYMENT_ON_ACCOUNT'), (r) => cents(r.amount)) : 0;
  const kpis = [
    { id: 'delivered', label: 'Gallons delivered', value: meterOk ? fmtGal(delivered) : 'unavailable', basis: 'net at 60 °F, from the truck meters', status: meterOk ? 'ok' : 'unavailable' },
    { id: 'revenue_posted', label: 'Delivery revenue posted', value: postedOk ? fmtUsd(sum(act, (r) => cents(r.amount))) : 'unavailable', basis: postedOk ? `${act.length} transactions, ${fmtGal(sum(act, (r) => tenths(r.net_gal)))}, posted in Cargas (accrual)` : `posted export ${status.cargas_posted.status}`, status: postedOk ? 'ok' : 'unavailable' },
    { id: 'counter_sales', label: 'Counter sales', value: counter === null ? 'unavailable' : fmtUsd(counter), basis: `POS, before tax${poa ? `, excludes ${fmtUsd(poa)} paid on account` : ''}`, status: counter === null ? 'unavailable' : posState === 'ok' ? 'ok' : 'partial' },
    { id: 'payments', label: 'Customer payments', value: ok('cargas_payments') ? fmtUsd(sum(chosen.cargas_payments.rows, (r) => cents(r.amount))) : 'unavailable', basis: 'recorded in Cargas', status: ok('cargas_payments') ? 'ok' : 'unavailable' },
    { id: 'deposits', label: 'Deposits booked', value: ok('qbo_deposits') ? fmtUsd(sum(chosen.qbo_deposits.rows, (r) => cents(r.TotalAmt))) : 'unavailable', basis: 'QuickBooks Online, net of card fees', status: ok('qbo_deposits') ? 'ok' : 'unavailable' },
    { id: 'margin', label: 'Gross margin', value: 'not calculated', basis: 'no cost method in this sample', status: 'unavailable' },
  ];

  // 7. one ledger line per rule
  const ledger = [...RULES.map((r) => r.id)].map((id) => {
    const ls = lines.filter((l) => l.rule === id);
    if (!ls.length) return { rule: id, title: ruleDef[id].title, state: 'not applicable', counts: {} };
    const counts = {}; for (const l of ls) counts[l.status] = (counts[l.status] || 0) + 1;
    const susp = ls.find((l) => l.status === 'suspended');
    return { rule: id, title: ruleDef[id].title, counts, checked: ls.filter((l) => l.status !== 'suspended').length, state: susp ? 'suspended' : counts.flag ? 'flag' : counts.pending ? 'pending' : counts.explained ? 'explained' : 'pass',
      notes: [...ls.filter((l) => l.note).map((l) => `${l.scope}: ${l.note}`), ...(susp?.blockedBy ? [`waiting for: ${susp.blockedBy.map((b) => `${SOURCES[b].system} ${SOURCES[b].label.toLowerCase()}`).join(', ')}`] : [])] };
  });

  const sources = Object.entries(status).filter(([n, s]) => s.status !== 'none').map(([n, s]) => ({ source: n, label: SOURCES[n].label, system: SOURCES[n].system, kind: SOURCES[n].kind, ...s }));
  const report = { day, runAt, rerunAt, posClose, closeOnTime, sources, fileLog, kpis, dossiers, ledger, lines };
  report.counts = { person: person.length, cannot: cannot.length, explained: explained.length, rules: ledger.filter((l) => l.state !== 'not applicable').length };
  report.summary = buildSummary(report);
  return report;
}
