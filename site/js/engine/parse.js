// Reads one received file. CSV exports carry a first line "#source=...;period=..." and, when the
// exporting system provides one, a last line "#trailer;rows=...;amount=..." (control totals).
// QuickBooks files are API query responses (JSON). Formats on the Cargas and POS side are assumed.
import { fingerprint } from './util.js';

function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function kv(line) {
  const o = {};
  for (const part of line.replace(/^#/, '').split(';')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i)] = part.slice(i + 1); }
  return o;
}

export function parseFile(path, text, receivedAt) {
  const base = { path, received_at: receivedAt, hash: fingerprint(text), text };
  if (path.endsWith('.json')) {
    let j;
    try { j = JSON.parse(text); } catch { return { ...base, meta: {}, error: 'not valid JSON' }; }
    if (j._export) {
      const entity = Object.keys(j.QueryResponse || {}).find((k) => Array.isArray(j.QueryResponse[k]));
      const list = entity ? j.QueryResponse[entity] : [];
      return { ...base, meta: { ...j._export }, entity, rows: list, control: { announced: j.QueryResponse?.totalCount, received: list.length } };
    }
    return { ...base, meta: { source: j.source, period: j.period, generated: j.generated }, doc: j, rows: j.lines || [] };
  }
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  const meta = lines[0]?.startsWith('#') ? kv(lines[0]) : {};
  const body = lines.filter((l, i) => !(i === 0 && l.startsWith('#')) && !l.startsWith('#trailer'));
  const trailerLine = lines.find((l) => l.startsWith('#trailer'));
  const cols = body.length ? splitCsvLine(body[0]) : [];
  const rows = body.slice(1).map((l, i) => { const v = splitCsvLine(l); const r = { _line: i + 3 }; cols.forEach((c, k) => { r[c] = v[k] ?? ''; }); return r; });
  return { ...base, meta, cols, rows, trailer: trailerLine ? kv(trailerLine) : null };
}
