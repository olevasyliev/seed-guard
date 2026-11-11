// Screenshots from the Photos library through the PhotoKit helper (build/photos-helper).
// Demo mode reads a plain folder of test images instead, with the same interface.
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_SCOPE } from './scope.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(here, '../../build/photos-helper');
const MAX_SIDE = 1600; // a phone screenshot scaled to this still has seed words 25-35 px tall
const env = process.env;

// Demo mode: every image in this folder, by default the generated eval set in eval/fixtures (`npm run fixtures`). A
// folder, not a Photos album, because Photos keeps many originals only in iCloud and a demo must not depend on what
// this Mac has kept.
const DEMO_DIR = DEMO_SCOPE ? path.resolve(process.env.SEED_GUARD_DEMO_IMAGES || path.join(here, '../../eval/fixtures')) : null;
const IMAGE = /\.(png|jpe?g|heic)$/i;
function demoImages(since) {
  const from = since ? Date.parse(since) : 0;
  return fs.readdirSync(DEMO_DIR).filter((n) => IMAGE.test(n)).sort()
    .map((n) => { const file = path.join(DEMO_DIR, n); return { id: file, file, date: fs.statSync(file).mtime }; })
    .filter((x) => x.date.getTime() >= from);
}

const callIn = (album, ...args) => new Promise((resolve, reject) =>
  execFile(HELPER, args, { env: album ? { ...env, SEED_GUARD_ALBUM: album } : env }, (err, out) => (err ? reject(err) : resolve(JSON.parse(out.trim().split('\n').pop())))));
const call = (...args) => callIn(null, ...args);

// Ids of the images in a named album, for scoring a test set without reading anything in it.
export const albumIds = async (album) => new Set((await callIn(album, 'ids')).ids ?? []);

export const yearAgo = () => new Date(Date.now() - 365 * 864e5).toISOString().replace(/\.\d+Z$/, 'Z');

// Shows the macOS Photos prompt the first time; later calls return the stored answer.
export async function requestPhotos() {
  if (DEMO_DIR) return fs.existsSync(DEMO_DIR) ? 'authorized' : `no demo folder at ${DEMO_DIR}`;
  const { status } = await call('status');
  return status === 'notDetermined' ? (await call('request')).status : status;
}

// Counts only: screenshots Photos can hand over from this Mac, iCloud-only ones, and a five-item download test.
export async function probePhotos(since) {
  if (DEMO_DIR) { const n = demoImages(since).length; return { total: n, tally: { 'demo folder': n } }; }
  return call('probe', since ?? 'all');
}

export async function countScreenshots() {
  if (DEMO_DIR) return { all: demoImages(null).length, year: demoImages(yearAgo()).length };
  const [all, year] = await Promise.all([call('count', 'all'), call('count', yearAgo())]);
  return { all: all.count, year: year.count };
}

// Yields { i, total, id, date, path } one screenshot at a time; the caller deletes the file, then asks for the next.
export async function* exportScreenshots(since) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-guard-'));
  fs.chmodSync(dir, 0o700);
  if (DEMO_DIR) {
    try {
      const images = demoImages(since);
      for (const [i, x] of images.entries()) {
        const out = path.join(dir, `shot-${i}.jpg`);
        // The same conversion the eval uses, so the demo reads exactly what the eval scored.
        const ok = await new Promise((resolve) => execFile('sips', ['-Z', String(MAX_SIDE), '-s', 'format', 'jpeg', x.file, '--out', out], (err) => resolve(!err)));
        const item = { i, total: images.length, id: x.id, date: x.date.toISOString(), ...(ok ? { path: out } : { error: 'unavailable' }) };
        const stop = yield item;
        fs.rmSync(out, { force: true });
        if (stop) break;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return;
  }
  const p = spawn(HELPER, ['export', since ?? 'all', dir, String(MAX_SIDE)], { env });
  const lines = createInterface({ input: p.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  try {
    for (;;) {
      const { value, done } = await lines.next();
      if (done) break;
      const item = JSON.parse(value);
      if (item.done || item.error && item.i === undefined) break;
      const stop = yield item;
      if (item.path) fs.rmSync(item.path, { force: true });
      p.stdin.write(stop ? 'stop\n' : 'next\n');
      if (stop) break;
    }
  } finally {
    p.stdin.end();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function openPhoto(id) {
  if (DEMO_DIR) { spawn('open', [id]); return; } // a demo image is a file: open it in Preview
  spawn('osascript', ['-e', `tell application "Photos" to activate`, '-e', `tell application "Photos" to spotlight media item id ${JSON.stringify(id)}`]);
}
