// The morning summary is written by this code, not by a model: one sentence per dossier, from fixed
// templates that quote only the dossier's own fields. verifySummary() checks any summary (this one, or a
// text written elsewhere) the other way round: every figure and identifier in a sentence must belong to
// the dossier it points to, the sentence must carry that dossier's qualification, and words that would
// turn a difference into an accusation are refused.

const T = {
  'TICKET_POSTED:flag': (f) => `Ticket ${f.ticket} (truck ${f.truck}, ${f.net} net, printed ${f.time}) is not among the transactions posted in Cargas after the ${f.deadline} deadline on ${f.period}: ${f.qualification}, ${f.amount} at the plan price.`,
  'TICKET_POSTED:pending': (f) => `Route ${f.route} was still open in the export, so ticket ${f.tickets} is not posted yet: ${f.qualification} until the next run.`,
  'DEPOSIT_TO_QBO:explained': (f) => `Card deposit ${f.deposit}: ${f.cargas} in Cargas and ${f.qbo} booked in QuickBooks; the ${f.diff} difference is the fee on settlement ${f.batch}: ${f.qualification}.`,
  'DEPOSIT_TO_QBO:flag': (f) => (f.cargas ? `Deposit ${f.deposit}: ${f.cargas} in Cargas and ${f.qbo} in QuickBooks: ${f.qualification} of ${f.diff}.` : null),
  'POS_COMPLETENESS:suspended': (f) => (f.from ? `The POS export covers ${f.from} to ${f.to} and no register close came with it: counter sales of ${f.partial} are partial and ${f.n} counter checks are ${f.qualification}.` : null),
  'SOURCE_FRESH_COMPLETE:suspended': (f) => (f.covers ? `The ${f.source} file (received ${f.received}) covers ${f.covers}, not ${f.period}: ${f.n} checks that need it are ${f.qualification}.`
    : f.announced ? `The ${f.source} export holds ${f.rows} of the ${f.announced} rows its trailer announces: ${f.n} checks that need it are ${f.qualification}.` : null),
  'POS_CASH_TO_QBO:flag': (f) => `Register close ${f.z} shows ${f.zcash} in cash and the QuickBooks cash deposit is ${f.qbo}: ${f.qualification} of ${f.diff}.`,
  'POS_CARD_TO_SETTLEMENT:explained': (f) => `Counter card batch ${f.batch}: ${f.gross} on the register close, ${f.net} deposited after a ${f.fee} fee: ${f.qualification}.`,
  'CAGE_COUNT:flag': (f) => `Cage ${f.cage} at ${f.dealer}: ${f.expected} full cylinders expected from the movements on file, ${f.counted} counted: ${f.qualification}, ${f.diff} cylinder.`,
  'LEASE_BILLED:flag': (f) => `Lease ${f.lease} (tank ${f.tank}, ${f.customer}) has no charge for the ${f.rent} rent due ${f.due}, and its cycle closed ${f.close}: ${f.qualification}.`,
  'GL_BATCH_TO_QBO:flag': (f) => (f.acct_more ? `Batch ${f.batch} reached QuickBooks with the same total, but ${f.amount} is credited to ${f.acct_more} instead of ${f.acct_less}: ${f.qualification}.` : null),
  'PRICE_PLAN:flag': (f) => `Ticket ${f.ticket} (${f.account}) was posted at ${f.price} against a plan price of ${f.plan}, with no contract or approval on file: ${f.qualification}, ${f.amount}.`,
  'PRICE_PLAN:explained': (f) => `Ticket ${f.ticket} (${f.account}) at ${f.price}, below the ${f.plan} plan price, is covered by ${f.doc}: ${f.qualification}.`,
  'POSTED_MATCH:explained': (f) => `Ticket ${f.ticket}, delivered ${f.delivered} and posted ${f.posted}, matches its meter ticket: ${f.qualification} as a late posting.`,
  'BULK_BALANCE:flag': (f) => `Plant and trucks close an estimated ${f.diff} ${f.direction} the expected ${f.expected}, beyond the ${f.tol} tolerance: ${f.qualification}, from gauge readings rather than a measured quantity.`,
  'BULK_BALANCE:suspended': (f) => `The ${f.time} reading of ${f.vessel} has no temperature and no net quantity, so the plant balance is ${f.qualification}: no correction is guessed.`,
};

export function buildSummary(report) {
  const R = report.counts;
  const parts = [R.person ? `${R.person} need${R.person === 1 ? 's' : ''} a person` : 'nothing needs a person'];
  if (R.cannot) parts.push(`${R.cannot} cannot conclude yet`);
  if (R.explained) parts.push(`${R.explained} explained`);
  const lead = { refs: ['R'], text: `${R.rules} rules ran for ${reportFields(report).period}: ${parts.join(', ')}.` };
  const out = [lead];
  for (const d of report.dossiers) {
    const t = T[`${d.rule}:${d.status}`];
    const text = (t && t(d.fields)) || `${d.ruleTitle}: ${d.fields.qualification}, see dossier ${d.id}.`;
    out.push({ refs: [d.id], text });
  }
  return out;
}

export function reportFields(report) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const x = new Date(`${report.day}T12:00:00Z`);
  return { period: `${days[x.getUTCDay()]} ${x.getUTCDate()} ${mon[x.getUTCMonth()]}`, rules: String(report.counts.rules), person: String(report.counts.person), cannot: String(report.counts.cannot), explained: String(report.counts.explained) };
}

const TOKEN = /-?\$\d+\.\d{3}\/gal|-?\$[\d,]+\.\d{2}|-?[\d,]+\.\d gal|\b[A-Z]{1,3}(?:-[A-Z0-9]+)+\b|\b\d{1,2}:\d{2}\b|\b\d[\d,]*\b/g;
const BANNED = /\b(loss|losses|lost|theft|stolen|steal|leak|leaking|fraud|shrinkage|never billed|never invoiced)\b/i;
export const tokens = (s) => String(s ?? '').match(TOKEN) || [];

export function verifySummary(summary, report) {
  const byId = Object.fromEntries(report.dossiers.map((d) => [d.id, d]));
  const errors = []; let traced = 0;
  summary.forEach((s, i) => {
    const allowed = new Set();
    for (const r of s.refs) {
      const fields = r === 'R' ? reportFields(report) : byId[r]?.fields;
      if (!fields) { errors.push(`sentence ${i + 1}: points to unknown dossier ${r}`); continue; }
      for (const v of Object.values(fields)) for (const t of tokens(v)) allowed.add(t);
      if (r !== 'R' && !s.text.toLowerCase().includes(byId[r].qualificationLabel)) errors.push(`sentence ${i + 1}: does not carry the qualification of dossier ${r} (${byId[r].qualificationLabel})`);
    }
    for (const t of tokens(s.text)) { if (allowed.has(t)) traced++; else errors.push(`sentence ${i + 1}: "${t}" is not a field of dossier ${s.refs.join(', ')}`); }
    const b = s.text.match(BANNED); if (b) errors.push(`sentence ${i + 1}: the word "${b[0]}" states more than the records show`);
  });
  return { ok: errors.length === 0, errors, traced, sentences: summary.length };
}
