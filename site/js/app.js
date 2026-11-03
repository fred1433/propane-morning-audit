// The page: loads the fictional files, runs the same engine the tests run, and draws what it returns.
import { prepare, runDay, SOURCES } from './engine/engine.js';
import { verifySummary } from './engine/summary.js';
import { fmtDay, fmtDayLong, fmtStamp } from './engine/util.js';

const DAYS = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
const REPO = 'https://github.com/fred1433/propane-morning-audit/blob/main';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const $ = (s) => document.querySelector(s);

let FILES; let COMMIT; let JOURNAL;
const params = new URLSearchParams(location.search);
const state = { day: DAYS.includes(params.get('day')) ? params.get('day') : '2026-10-29', pos: {}, sel: params.get('d') || null };
if (['missing', 'received'].includes(params.get('pos'))) state.pos[state.day] = params.get('pos');

const QLABEL = { billing_to_verify: 'Billing to verify', accounting_difference: 'Accounting difference', settlement_pending: 'Settlement pending', quantity_to_confirm: 'Quantity to confirm', explained: 'Explained', not_concluded: 'Not concluded' };
function qualified(d) {
  if (d.qualification === 'quantity_to_confirm') return d.rule === 'CAGE_COUNT' ? `${d.fields.diff} cylinder` : d.rule === 'BULK_BALANCE' ? `${d.fields.diff}, estimated` : d.fields.diff || '';
  if (d.qualification === 'not_concluded') return '';
  return money(d);
}
const money = (d) => (d.amount !== undefined ? `$${(Math.abs(d.amount) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '');

function report() { return runDay(FILES, state.day, state.pos[state.day] ? { posClose: state.pos[state.day] } : {}); }

function tabs() {
  $('#tabs').innerHTML = DAYS.map((d) => {
    const r = runDay(FILES, d, state.pos[d] ? { posClose: state.pos[d] } : {});
    const sel = d === state.day;
    return `<button role="tab" aria-selected="${sel}" class="tab${sel ? ' is-on' : ''}" data-day="${d}"><span class="t-day">${fmtDay(d).slice(0, 6)}</span><span class="pips" aria-label="${r.counts.person} need a person, ${r.counts.cannot} cannot conclude">${r.counts.person ? `<i class="pip p">${r.counts.person}</i>` : ''}${r.counts.cannot ? `<i class="pip c">${r.counts.cannot}</i>` : ''}${!r.counts.person && !r.counts.cannot ? '<i class="pip ok">clear</i>' : ''}</span></button>`;
  }).join('');
}

function sheet(r) {
  const usable = r.sources.filter((s) => s.status === 'ok').length; const notUsable = r.sources.length - usable;
  const v = verifySummary(r.summary, r);
  const byId = Object.fromEntries(r.dossiers.map((d) => [d.id, d]));
  const thuLate = !r.closeOnTime && r.day === '2026-10-29';
  const col = (key, title, empty) => {
    const ds = r.dossiers.filter((d) => d.column === key);
    return `<div class="col col-${key}"><h3>${title} <span class="n">${ds.length}</span></h3>${ds.length ? `<ul>${ds.map((d) => `<li><button class="dossier${d.id === state.sel ? ' is-sel' : ''}" data-id="${d.id}" aria-controls="records"><span class="letter">${d.id}</span><span class="hl">${esc(d.headline)}</span><span class="q q-${d.qualification}">${QLABEL[d.qualification]}${qualified(d) ? ` <b>${esc(qualified(d))}</b>` : ''}</span></button></li>`).join('')}</ul>` : `<p class="empty">${empty}</p>`}</div>`;
  };
  const order = ['person', 'explained', 'cannot'].map((k) => r.dossiers.filter((d) => d.column === k));
  const mob = [...order.map((l) => l[0]).filter(Boolean), ...order.flatMap((l) => l.slice(1))];
  const COLNAME = { person: 'Needs a person', cannot: 'Cannot conclude yet', explained: 'Explained by a record' };
  const item = (d) => `<button class="dossier${d.id === state.sel ? ' is-sel' : ''}" data-id="${d.id}" aria-controls="records"><span class="letter">${d.id}</span><span class="hl">${esc(d.headline)}</span><span class="q q-${d.qualification}">${QLABEL[d.qualification]}${qualified(d) ? ` <b>${esc(qualified(d))}</b>` : ''}</span></button>`;
  const lead = r.summary[0].text;
  return `
  <div class="sheet-head">
    <div class="co"><span class="co-name">Sample Propane Co.</span><span class="co-sub">El Paso, Texas. A fictional distributor.</span></div>
    <div class="form-title">Daily close audit</div>
    <div class="serial" aria-label="Report number">No. <b>${r.day.slice(5, 7)}${r.day.slice(8)}</b></div>
  </div>
  <div class="cells">
    <div class="cell"><span class="lbl">Business day</span><span class="val">${fmtDayLong(r.day)}</span></div>
    <div class="cell"><span class="lbl">Report run</span><span class="val">${r.rerunAt ? `Re-run ${fmtStamp(r.rerunAt)}` : fmtStamp(r.runAt)}</span>${r.rerunAt ? '<span class="hint">after the register close arrived</span>' : '<span class="hint">scheduled, Mountain Time</span>'}</div>
    <div class="cell"><span class="lbl">Sources</span><span class="val">${usable} usable${notUsable ? `, <em>${notUsable} not</em>` : ''}</span><span class="hint">listed at the foot of the sheet</span></div>
    <div class="cell cell-toggle"><span class="lbl" id="pos-l">POS register close</span>
      <div class="seg" role="radiogroup" aria-labelledby="pos-l">
        <button role="radio" data-pos="received" aria-checked="${r.posClose === 'received'}">${thuLate ? 'Received at 09:40' : 'Received'}</button>
        <button role="radio" data-pos="missing" aria-checked="${r.posClose === 'missing'}">Missing</button>
      </div>
      <span class="print-only val">${r.posClose === 'missing' ? 'Missing' : 'Received'}</span>
      <span class="hint">${thuLate ? (r.posClose === 'missing' ? 'as it stood at 06:00' : 'the run is repeated with it') : 'take it away to see the report hold back'}</span></div>
  </div>
  <div class="kpis">${r.kpis.map((k) => `<div class="kpi kpi-${k.status}"><span class="lbl">${k.label}</span><span class="val">${esc(k.value)}${k.status === 'partial' ? ' <em>partial</em>' : ''}</span><span class="hint">${esc(k.basis)}</span></div>`).join('')}</div>
  <div class="cols">
    ${col('person', 'Needs a person', 'Nothing needs a person today.')}
    ${col('cannot', 'Cannot conclude yet', 'Nothing held back: every source arrived usable.')}
    ${col('explained', 'Explained by a record', 'No difference needed explaining.')}
  </div>
  <div class="mlist"><p class="m-lead">${esc(lead)}</p><ul>${mob.map((d) => `<li class="m-${d.column}"><span class="m-col">${COLNAME[d.column]}</span>${item(d)}</li>`).join('')}</ul></div>
  <p class="scope-note">Gross margin is not calculated: this sample has no cost method. Tax amounts are copied from the records.</p>
  <details class="summary note"><summary><span class="note-t">Morning note</span> ${esc(lead)}</summary>
    <ol>${r.summary.slice(1).map((s) => `<li>${esc(s.text)} <a class="tag" href="#records" data-id="${s.refs[0]}" aria-label="Open dossier ${s.refs[0]}">${s.refs[0]}</a></li>`).join('')}</ol>
    <p class="trace">${v.ok ? `Written by the code from fixed templates. Reference check: each of the ${v.traced} figures, identifiers and names in these sentences belongs to the dossier it cites. It checks references, not the meaning of a sentence.` : `Reference check failed: ${esc(v.errors[0])}`}</p>
    <p class="claude">In production, Claude would write this note from the dossiers and answer questions about any of them; the figures and the conclusions stay with the code. This page calls no model.</p>
  </details>
  <details class="ledger"><summary>${r.counts.rules} checks for this day: ${r.counts.completed} completed${r.counts.held ? `, ${r.counts.held} held back` : ''}</summary>
    <div class="tscroll"><table><thead><tr><th>Rule</th><th>Checked</th><th>Result</th><th>Notes</th></tr></thead><tbody>
    ${r.ledger.map((l) => `<tr class="st-${l.state.replace(/ /g, '-')}"><td><span class="rid">${l.rule}</span><br>${esc(l.title)}</td><td>${l.state === 'not applicable' ? '' : l.checked}</td><td><span class="res">${{ pass: 'passed', flag: 'needs a person', pending: 'pending', explained: 'explained', suspended: 'suspended', 'not applicable': 'no records today' }[l.state]}</span></td><td>${(l.notes || []).map(esc).join('<br>')}</td></tr>`).join('')}
    </tbody></table></div></details>
  <details class="files"><summary>Files used by this run</summary>
    <div class="tscroll"><table><thead><tr><th>System</th><th>Source</th><th>File</th><th>Received</th><th>Status</th></tr></thead><tbody>
    ${r.sources.map((s) => `<tr class="fs-${s.status}"><td>${esc(s.system)}</td><td>${esc(s.label)}</td><td class="mono">${esc((s.file || '').split('/').pop())}</td><td>${s.received_at ? fmtStamp(s.received_at) : ''}</td><td><span class="res">${s.status === 'ok' ? 'used' : s.status}</span>${s.detail ? `<br><small>${esc(s.detail)}</small>` : ''}</td></tr>`).join('')}
    ${r.fileLog.map((l) => `<tr class="fs-log"><td>${esc(SOURCES[l.source]?.system || '')}</td><td>${esc(SOURCES[l.source]?.label || l.source)}</td><td class="mono">${esc(l.path.split('/').pop())}</td><td>${fmtStamp(l.received_at)}</td><td><span class="res">${l.status.replace('_', ' ')}</span><br><small>${esc(l.detail)}</small></td></tr>`).join('')}
    </tbody></table></div></details>
  <div class="sheet-foot">
    <p>Calculations executed by the code in this page (engine at commit <a href="https://github.com/fred1433/propane-morning-audit/tree/${esc(COMMIT)}">${esc(COMMIT)}</a>), on the fictional files above. No model call: API cost $0.</p>
    <button class="print" id="print">Print this report</button>
  </div>`;
}

function cardHtml(c) {
  return `<figure class="rec rec-${c.style}">
    <figcaption><span class="sys">${esc(c.system)}</span><span class="ttl">${esc(c.title)}</span></figcaption>
    <div class="rec-body"><table><thead><tr>${c.columns.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>
    ${c.rows.map((row) => `<tr${row.mark ? ` class="m-${row.mark}"` : ''}>${row.cells.map((x) => `<td>${esc(x)}</td>`).join('')}</tr>`).join('')}
    </tbody></table>
    ${c.foot?.length ? `<dl>${c.foot.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}</div>
    <p class="src">${esc(c.file)}${c.received_at ? `, received ${fmtStamp(c.received_at)}` : ''}</p>
  </figure>`;
}

function records(r) {
  if (!r.dossiers.length) { $('#records-body').innerHTML = '<h2 id="records-h">Records behind a dossier</h2><p class="empty">No dossier for this day.</p>'; return; }
  if (!r.dossiers.find((d) => d.id === state.sel)) state.sel = r.dossiers[0].id;
  const d = r.dossiers.find((x) => x.id === state.sel);
  const ruleLink = ['POS_COMPLETENESS', 'SOURCE_FRESH_COMPLETE'].includes(d.rule) ? `${REPO}/src/engine.js` : `${REPO}/src/rules.js`;
  $('#records-body').innerHTML = `
  <div class="rec-head">
    <h2 id="records-h">Records behind dossier <span class="big">${d.id}</span></h2>
    <div class="chips" role="tablist" aria-label="Dossiers">${r.dossiers.map((x) => `<button role="tab" class="chip c-${x.column}${x.id === d.id ? ' is-on' : ''}" aria-selected="${x.id === d.id}" data-id="${x.id}">${x.id}</button>`).join('')}</div>
  </div>
  <div class="d-title d-${d.column}">
    <p class="d-hl">${esc((r.summary.find((x) => x.refs[0] === d.id) || {}).text || d.headline)}</p>
    <p class="d-q"><span class="q q-${d.qualification}">${QLABEL[d.qualification]}${qualified(d) ? ` <b>${esc(qualified(d))}</b>` : ''}</span>${d.action ? `<span class="act">${esc(d.action)}</span>` : ''}</p>
    ${d.quantity ? `<p class="qty">Quantity: <b>${esc(d.quantity.value)}</b>, ${esc(d.quantity.base)}, from the ${esc(d.quantity.origin)}, ${esc(d.quantity.at)}. File ${esc(d.quantity.source)}.</p>` : ''}
    ${d.note ? `<p class="qty">${esc(d.note)}</p>` : ''}
    ${d.suspends?.length ? `<p class="qty">Checks held back until this is fixed: ${d.suspends.map((s) => `<span class="rid">${s}</span>`).join(', ')}.</p>` : ''}
  </div>
  <div class="d-grid">
    <div class="evidence">${(d.evidence || []).map(cardHtml).join('') || '<p class="empty">No record for this dossier.</p>'}</div>
    <aside class="rule" aria-label="Rule that raised it">
      <div class="r-text">
        <p class="r-id">Rule <span class="rid">${d.rule}</span></p>
        <h3>${esc(d.ruleTitle)}</h3>
        <p>${esc(d.rulePlain)}</p>
        <p class="formula">${esc(d.ruleFormula)}</p>
        <p class="links"><a href="${ruleLink}">Read the rule in the code</a> <a href="${REPO}/tests/cases.test.js">and its test</a></p>
      </div>
      ${d.calc?.length ? `<div class="r-calc"><p class="r-id">This dossier, worked out</p><table class="calc">${d.calc.map(([k, v, em]) => `<tr${em ? ' class="em"' : ''}><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table></div>` : ''}
    </aside>
  </div>`;
}

function journal() {
  const j = JOURNAL;
  $('#journal').innerHTML = `<table class="journal"><thead><tr><th>Business day</th><th>Run at</th><th>Result</th></tr></thead><tbody>${j.runs.map((r) => `<tr class="${r.started ? '' : 'miss'}"><td>${fmtDay(r.for)}</td><td>${r.started ? fmtStamp(r.started) : `none by ${esc(fmtStamp(j.alert.sent))}`}</td><td>${esc(r.result)}</td></tr>`).join('')}</tbody></table>
  <div class="alert"><p class="a-head"><span>Alert, ${esc(fmtStamp(j.alert.sent))}</span><span>sent by ${esc(j.alert.by)}</span></p><p class="a-subj">${esc(j.alert.subject)}</p><p>${esc(j.alert.body)}</p></div>`;
}

function render(scroll) {
  const r = report();
  tabs();
  $('#sheet').innerHTML = sheet(r);
  records(r);
  const q = new URLSearchParams({ day: state.day }); if (state.pos[state.day]) q.set('pos', state.pos[state.day]); if (state.sel) q.set('d', state.sel);
  history.replaceState(null, '', `?${q}`);
  if (scroll) document.getElementById('records').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-day],[data-pos],[data-id],#print');
  if (!t) return;
  if (t.dataset.day) { state.day = t.dataset.day; state.sel = null; render(); }
  else if (t.dataset.pos) { state.pos[state.day] = t.dataset.pos; state.sel = null; render(); }
  else if (t.dataset.id) { e.preventDefault(); state.sel = t.dataset.id; render(!t.classList.contains('chip')); }
  else if (t.id === 'print') { document.querySelectorAll('#sheet details').forEach((x) => { x.open = true; }); window.print(); }
});
document.addEventListener('keydown', (e) => {
  const tab = e.target.closest('.tab'); if (!tab || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const i = DAYS.indexOf(state.day) + (e.key === 'ArrowRight' ? 1 : -1); if (i < 0 || i >= DAYS.length) return;
  state.day = DAYS[i]; state.sel = null; render(); document.querySelector('.tab.is-on')?.focus();
});

const [bundle, jr] = await Promise.all([fetch('data/files.json').then((x) => x.json()), fetch('data/run_journal.json').then((x) => x.json())]);
FILES = prepare(bundle.files); COMMIT = bundle.commit; JOURNAL = jr;
journal();
render();
