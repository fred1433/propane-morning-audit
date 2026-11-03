// The page runs exactly this engine on exactly these files (run `npm run build` after a change).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { rawFiles } from './helpers.js';
const R = new URL('../', import.meta.url).pathname;

test('the page bundle holds the engine source unchanged', () => {
  for (const f of readdirSync(`${R}src`)) assert.equal(readFileSync(`${R}site/js/engine/${f}`, 'utf8'), readFileSync(`${R}src/${f}`, 'utf8'), f);
});
test('the page bundle holds the fixtures unchanged', () => {
  const bundle = JSON.parse(readFileSync(`${R}site/data/files.json`, 'utf8'));
  assert.deepEqual(bundle.files.map((f) => [f.path, f.received_at, f.text]), rawFiles().map((f) => [f.path, f.received_at, f.text]));
});
