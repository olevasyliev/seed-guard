// Runs the OCR worker over eval/fixtures and scores it against truth.json: found what is there, nothing where nothing is.
// Fixtures hold freshly generated, never-funded phrases and keys only. `npm run eval -- <folder>` scores any other
// folder of images with its own truth.json, for example a private set of real phone screenshots.
import { execFileSync, fork } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(process.argv[2] ?? path.join(here, 'fixtures'));
const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8'));
const worker = fork(path.join(here, '../src/engine/worker.mjs'), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const waiting = new Map();
const mb = (bytes) => Math.round(bytes / 1e6).toLocaleString('en-US');
worker.on('message', (m) => {
  if (m.models) process.stdout.write(`\rPreparing models: ${mb(m.models.done)} of ${mb(m.models.total)} MB ${m.models.label ?? 'done'}`.padEnd(70));
  if (m.id) { waiting.get(m.id)(m); waiting.delete(m.id); }
});
let id = 0;
const ask = (msg) => new Promise((resolve) => { const n = ++id; waiting.set(n, resolve); worker.send({ id: n, ...msg }); });
const scan = (image) => ask({ image });

// First run: the QVAC models are not cached yet. Download them with visible progress before timing any image.
const { missing } = await ask({ prepare: 'check' });
if (missing) {
  const r = await ask({ prepare: 'download' });
  process.stdout.write('\n');
  if (r.error) { console.error('Model download failed:', r.error); process.exit(1); }
}

const rows = [];
for (const [name, want] of Object.entries(truth)) {
  // Same input the app gives the worker: a JPEG with its long side at 1600 px (see photos-helper).
  const file = path.join(os.tmpdir(), `sg-eval-${name}.jpg`);
  const src = ['png', 'jpg'].map((ext) => path.join(dir, `${name}.${ext}`)).find((f) => fs.existsSync(f));
  execFileSync('sips', ['-Z', '1600', '-s', 'format', 'jpeg', src, '--out', file], { stdio: 'ignore' });
  const r = await scan(file);
  fs.rmSync(file, { force: true });
  const seed = r.findings?.find((f) => f.kind === 'seed_phrase' && f.certainty === 'checksum_valid');
  const key = r.findings?.find((f) => f.kind === 'private_key');
  const got = seed ? 'seed' : key ? 'private_key' : r.findings?.length ? 'probable' : 'none';
  const expected = want.kind === 'seed' ? 'seed' : want.kind;
  rows.push({ name, expected, got, ok: !r.error && got === expected, pass: r.pass, sec: ((r.ms ?? 0) / 1000).toFixed(1), error: r.error });
}
console.table(rows);
const ok = rows.filter((r) => r.ok).length;
const secrets = rows.filter((r) => r.expected !== 'none');
console.log(`${ok}/${rows.length} correct · secrets found ${secrets.filter((r) => r.ok).length}/${secrets.length} · false alarms ${rows.filter((r) => r.expected === 'none' && r.got !== 'none').length}`);
worker.kill();
