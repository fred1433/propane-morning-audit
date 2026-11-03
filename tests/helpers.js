import { readFileSync } from 'node:fs';
import { prepare, runDay } from '../src/engine.js';

const ROOT = new URL('../', import.meta.url).pathname;
export const DAYS = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
export function rawFiles() {
  const man = JSON.parse(readFileSync(`${ROOT}fixtures/manifest.json`, 'utf8'));
  return man.files.map((f) => ({ ...f, text: readFileSync(`${ROOT}fixtures/${f.path}`, 'utf8') }));
}
export const files = () => prepare(rawFiles());
export const cases = () => JSON.parse(readFileSync(`${ROOT}expected/cases.json`, 'utf8')).cases;
export const run = (fs, day, posClose) => runDay(fs, day, posClose ? { posClose } : {});
// replace one file's text, keep everything else
export function edit(raw, pathEnd, fn) {
  return raw.map((f) => (f.path.endsWith(pathEnd) ? { ...f, text: fn(f.text) } : f));
}
