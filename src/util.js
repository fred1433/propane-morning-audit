// Exact arithmetic on integers: gallons in tenths, money in cents, unit prices in thousandths of a dollar.
// Nothing here guesses: a value that does not parse is null, and callers treat null as "cannot conclude".

export function tenths(s) {
  if (s === undefined || s === null || String(s).trim() === '') return null;
  const m = String(s).trim().match(/^(-?)(\d+)(?:\.(\d))?$/);
  if (!m) return null;
  const v = Number(m[2]) * 10 + Number(m[3] || 0);
  return m[1] ? -v : v;
}

export function cents(s) {
  if (s === undefined || s === null || String(s).trim() === '') return null;
  if (typeof s === 'number') return Math.round(s * 100);
  const m = String(s).trim().replace(/,/g, '').match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const v = Number(m[2]) * 100 + Number((m[3] || '0').padEnd(2, '0'));
  return m[1] ? -v : v;
}

export function mills(s) {
  const m = String(s ?? '').trim().match(/^(\d+)\.(\d{3})$/);
  return m ? Number(m[1]) * 1000 + Number(m[2]) : null;
}

// gallons (tenths) x price (mills) -> cents, half up
export const extend = (t, m) => Math.floor((t * m) / 100 + 0.5);

export function fmtUsd(c) {
  const neg = c < 0; const a = Math.abs(c);
  const s = `$${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}
export function fmtGal(t) {
  const neg = t < 0; const a = Math.abs(t);
  return `${neg ? '-' : ''}${Math.floor(a / 10).toLocaleString('en-US')}.${a % 10} gal`;
}
export const fmtPrice = (m) => `$${Math.floor(m / 1000)}.${String(m % 1000).padStart(3, '0')}/gal`;

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const asDate = (d) => new Date(`${d.slice(0, 10)}T12:00:00Z`);
export const fmtDay = (d) => { const x = asDate(d); return `${DOW[x.getUTCDay()]} ${x.getUTCDate()} ${MON[x.getUTCMonth()]}`; };
export const fmtDayLong = (d) => { const x = asDate(d); return `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][x.getUTCDay()]} ${x.getUTCDate()} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][x.getUTCMonth()]} ${x.getUTCFullYear()}`; };
export const fmtStamp = (ts) => (ts ? `${fmtDay(ts)}, ${ts.slice(11, 16)}` : '');
export function addDays(d, n) { const x = asDate(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }

// FNV-1a over the text: two files with the same bytes get the same fingerprint
export function fingerprint(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + f(x), 0);
