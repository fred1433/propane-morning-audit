#!/usr/bin/env node
// Builds the page bundle: the engine source as is, plus every fictional file with its arrival time.
// The page runs this engine on these files in the browser; no figure is typed into the HTML.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const R = new URL('../', import.meta.url).pathname;
mkdirSync(`${R}site/js/engine`, { recursive: true }); mkdirSync(`${R}site/data`, { recursive: true });
for (const f of readdirSync(`${R}src`)) copyFileSync(`${R}src/${f}`, `${R}site/js/engine/${f}`);
const man = JSON.parse(readFileSync(`${R}fixtures/manifest.json`, 'utf8'));
let commit = 'uncommitted'; try { commit = execSync('git rev-parse --short HEAD', { cwd: R, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
writeFileSync(`${R}site/data/files.json`, JSON.stringify({ commit, files: man.files.map((f) => ({ ...f, text: readFileSync(`${R}fixtures/${f.path}`, 'utf8') })) }));
copyFileSync(`${R}examples/run_journal.json`, `${R}site/data/run_journal.json`);
console.log(`site bundle built from commit ${commit}: ${man.files.length} files`);
