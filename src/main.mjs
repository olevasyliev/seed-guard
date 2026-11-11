// Seed Guard main process: the window, macOS access, and the scan pipeline.
// Secrets never leave this process: the window only gets kinds, counts, dates and where to look.
import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, Notification, powerSaveBlocker } from 'electron';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectText } from './engine/detect.mjs';
import { countNotes, openNote, readNotes } from './sources/notes.mjs';
import { albumIds, countScreenshots, exportScreenshots, openPhoto, probePhotos, requestPhotos, yearAgo } from './sources/photos.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SECONDS_PER_SHOT = 6; // real images, 22.10: ~6 s on a test album, ~7 s on a real library; replaced by the measured average once screenshots start
const SECONDS_PER_NOTE = 0.03;

let win;
let worker;
const pending = new Map();
let seq = 0;
let state = { screen: 'start' };
let paused = false;

const send = (ch, data) => win?.webContents.send(ch, data);

// Light or dark, one switch in the window. nativeTheme drives the stylesheet (prefers-color-scheme) and the macOS chrome;
// it is always set explicitly, so a Mac in light mode still opens Seed Guard dark until the switch says otherwise.
const THEME_BG = { dark: '#161718', light: '#f4f6f5' }; // the first frame before the page draws; matches --bg in styles.css
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readTheme() {
  try {
    const t = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).theme;
    return { theme: t === 'light' ? 'light' : 'dark' };
  } catch (e) {
    if (e.code === 'ENOENT') return { theme: 'dark' }; // first run: nothing saved yet
    console.error('settings: could not read', e.message);
    return { theme: 'dark', themeError: 'Saved theme could not be read' };
  }
}
function applyTheme(theme) {
  nativeTheme.themeSource = theme;
  win?.setBackgroundColor(THEME_BG[theme]);
}
const setState = (patch) => { state = { ...state, ...patch }; send('state', state); };

function ask(msg) {
  worker ??= fork(path.join(here, 'engine/worker.mjs'), [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    .on('message', (m) => {
      // Model download progress is shown only while a check is on screen.
      if (m.models && state.screen === 'checking') setState({ progress: { phase: 'models', ...m.models } });
      if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
    });
  return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); worker.send({ id, ...msg }); });
}
const ocr = (image) => ask({ image });

// Kinds and counts only, plus where the user can find the item themselves.
function addFinding(f) {
  const findings = [...(state.findings ?? []), { id: state.findings?.length ?? 0, ...f }];
  setState({ findings });
}

async function access({ notes, shots }) {
  const counts = {};
  const errors = {};
  if (notes) {
    try { counts.notes = await countNotes(); } catch (e) { errors.notes = /not allowed|-1743/i.test(e.message) ? 'denied' : e.message; }
  }
  if (shots) {
    const status = await requestPhotos().catch((e) => e.message);
    if (status === 'authorized' || status === 'limited') counts.shots = await countScreenshots();
    else errors.shots = status;
  }
  // Screenshots need the QVAC models; on the first run they are not on this Mac yet.
  const download = counts.shots ? (await ask({ prepare: 'check' })).missing ?? 0 : 0;
  const estimate = {
    notes: counts.notes != null ? counts.notes * SECONDS_PER_NOTE + 10 : 0,
    year: counts.shots ? counts.shots.year * SECONDS_PER_SHOT : 0,
    all: counts.shots ? counts.shots.all * SECONDS_PER_SHOT : 0,
  };
  setState({ screen: 'ready', counts, errors, estimate, download, scope: 'year' });
  return state;
}
ipcMain.handle('access', (_e, sources) => access(sources));

async function scan({ notes, scope }) {
  setState({ screen: 'checking', findings: [], progress: { phase: notes ? 'notes' : 'shots', done: 0, total: 0 }, notesDone: null, modelsFailed: null });
  const started = Date.now();
  const awake = powerSaveBlocker.start('prevent-app-suspension'); // a long check must not stop when the Mac idles
  if (notes) {
    try {
      const { notes: n, skipped, brokenFolders } = await readNotes((note) => {
        for (const f of detectText(note.text).findings)
          addFinding({ source: 'note', ref: note.id, where: note.folder, date: note.modified ?? note.created, kind: f.kind, certainty: f.certainty, words: f.words?.length ?? f.recognised });
      }, (done, total) => setState({ progress: { phase: 'notes', done, total } }));
      setState({ notesDone: { checked: n, skipped, brokenFolders } });
    } catch (e) {
      // Notes failing must not strand the window on "Checking": screenshots still run, and the result says notes were not read.
      console.error('notes:', e.message);
      setState({ notesDone: { checked: 0, failed: true } });
    }
  }
  if (scope && state.counts?.shots && (await ask({ prepare: 'check' })).missing) {
    setState({ progress: { phase: 'models', done: 0, total: 0 } });
    const r = await ask({ prepare: 'download' });
    if (r.error) { console.error('models:', r.error); setState({ modelsFailed: true }); }
  }
  if (scope && state.counts?.shots && !state.modelsFailed) {
    const total = scope === 'all' ? state.counts.shots.all : state.counts.shots.year;
    let done = 0;
    let spent = 0;
    let missing = 0; // screenshots Photos could not hand over or the scan failed on: never counted as checked
    passes = {};
    const shots = exportScreenshots(scope === 'all' ? null : yearAgo());
    for (let next = await shots.next(); !next.done; next = await shots.next(stopRequested())) {
      const item = next.value;
      while (paused) await new Promise((r) => setTimeout(r, 300));
      if (item.path) {
        const r = await ocr(item.path);
        if (r.error) missing++; // a failed scan read nothing: never counted as checked
        spent += r.ms ?? 0;
        passes[r.pass ?? r.error ?? 'none'] = (passes[r.pass ?? r.error ?? 'none'] ?? 0) + 1;
        for (const f of r.findings ?? [])
          addFinding({ source: 'screenshot', ref: item.id, where: 'Photos', date: item.date, kind: f.kind, certainty: f.certainty, words: f.words });
      } else missing++;
      done++;
      const read = done - missing;
      setState({ progress: { phase: 'shots', done, total, missing, left: read ? Math.round(((spent / read) / 1000) * (total - done)) : null } });
      win?.setProgressBar(done / total);
    }
  }
  win?.setProgressBar(-1);
  powerSaveBlocker.stop(awake);
  setState({ screen: 'results', took: Math.round((Date.now() - started) / 1000) });
  writeSummary(started);
  if (state.took > 60 && !win?.isFocused()) notifyDone();
  return state;
}

// The check can take hours, so the window may be closed or behind others when it ends. Counts only, never the secret.
function notifyDone() {
  const count = (pick) => (state.findings ?? []).filter(pick).length;
  const phrases = count((f) => f.kind === 'seed_phrase' && f.certainty === 'checksum_valid');
  const keys = count((f) => f.kind === 'private_key');
  const maybes = count((f) => f.certainty === 'probable');
  const many = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const found = [phrases && many(phrases, 'recovery phrase'), keys && many(keys, 'private key')].filter(Boolean).join(' and ');
  const missing = state.progress?.missing ? ` ${many(state.progress.missing, 'screenshot')} could not be read.` : '';
  const n = new Notification({
    title: 'Seed Guard finished the check',
    body: (found ? `Found ${found}. Open Seed Guard to see where.` : maybes ? `Nothing certain, ${many(maybes, 'item')} to look at.` : 'Nothing found in what was checked.') + missing,
  });
  n.on('click', () => { if (!win) createWindow(); else win.show(); });
  n.show();
}
ipcMain.handle('scan', (_e, plan) => scan(plan));

// Counts-only record of the last run, for tuning the time estimate: no places, dates or text.
let passes = {};
function writeSummary(started) {
  const tally = {};
  for (const f of state.findings ?? []) { const k = `${f.source} ${f.kind} ${f.certainty}`; tally[k] = (tally[k] ?? 0) + 1; }
  const shots = state.progress?.phase === 'shots' ? state.progress.done - (state.progress.missing ?? 0) : 0;
  const summary = { at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), notes: state.notesDone, screenshots: shots, notRead: state.progress?.missing ?? 0, passes, tally };
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(path.join(app.getPath('userData'), 'last-run.json'), JSON.stringify(summary, null, 2));
}

let stop = false;
const stopRequested = () => stop;
// The real Notes and Photos icons, read from the system at runtime rather than shipped with the app.
ipcMain.handle('icons', async () => {
  const icon = async (app) => (await nativeImage.createThumbnailFromPath(`/System/Applications/${app}.app`, { width: 128, height: 128 })).toDataURL();
  const finder = (await nativeImage.createThumbnailFromPath('/System/Library/CoreServices/Finder.app', { width: 128, height: 128 })).toDataURL();
  return { note: await icon('Notes'), screenshot: await icon('Photos'), files: finder };
});
ipcMain.handle('pause', (_e, value) => { paused = value; setState({ paused }); });
ipcMain.handle('state', () => state);
ipcMain.handle('theme', (_e, theme) => {
  if (theme !== 'light' && theme !== 'dark') return;
  applyTheme(theme);
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ theme }, null, 2));
    setState({ theme, themeError: null });
  } catch (e) {
    console.error('settings: could not save', e.message);
    setState({ theme, themeError: 'Not saved, resets on next launch' });
  }
});
ipcMain.handle('restart', () => { stop = false; paused = false; setState({ screen: 'start', findings: [], progress: null }); });
ipcMain.handle('open', (_e, id) => {
  const f = state.findings?.find((x) => x.id === id);
  if (f?.source === 'note') openNote(f.ref);
  if (f?.source === 'screenshot') openPhoto(f.ref);
});

function createWindow() {
  win = new BrowserWindow({
    width: 740, height: 520, useContentSize: true, resizable: false, maximizable: false, fullscreenable: false,
    titleBarStyle: 'hiddenInset', backgroundColor: THEME_BG[state.theme], title: 'Seed Guard', show: false,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(here, 'ui/index.html'));
  win.once('ready-to-show', () => { if (!headless) win.show(); });
  win.on('closed', () => { win = null; });
}

// SEED_GUARD_SHOTS=<dir>: renders each screen with made-up state into PNGs and quits (visual check, no macOS prompts).
async function captureScreens(dir) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  win.webContents.on('console-message', (_e, _l, msg) => console.log('[ui]', msg));
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  // The first screen would otherwise be captured before Geist and the system icons have loaded.
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  await new Promise((r) => setTimeout(r, 1500));
  const f = (id, source, kind, certainty, words, date, where) => ({ id, source, ref: 'x', kind, certainty, words, date, where });
  const findings = [
    f(0, 'note', 'seed_phrase', 'checksum_valid', 12, '2021-03-14T10:00:00Z', 'Crypto'), f(1, 'note', 'seed_phrase', 'checksum_valid', 24, '2020-11-03T10:00:00Z', 'Notes'),
    f(2, 'screenshot', 'seed_phrase', 'checksum_valid', 12, '2023-06-02T10:00:00Z', 'Photos'), f(3, 'note', 'private_key', 'pattern', null, '2022-01-20T10:00:00Z', 'Work'),
    f(4, 'note', 'seed_phrase', 'probable', 13, '2019-05-05T10:00:00Z', 'Notes'),
  ];
  const shots = {
    start: { screen: 'start' },
    ready: { screen: 'ready', counts: { notes: 1144, shots: { all: 4812, year: 1206 } }, errors: {}, estimate: { notes: 44, year: 3015, all: 12030 }, download: 3218913696 },
    models: { screen: 'checking', progress: { phase: 'models', label: 'Handwriting reader', done: 1405000000, total: 3218913696 }, notesDone: { checked: 1144 }, findings: findings.slice(0, 2) },
    checking: { screen: 'checking', progress: { phase: 'shots', done: 460, total: 1206, left: 900 }, notesDone: { checked: 1144 }, findings: findings.slice(0, 3) },
    results: { screen: 'results', findings, notesDone: { checked: 1144 } },
    clean: { screen: 'results', findings: [], notesDone: { checked: 1144 }, progress: { phase: 'shots', done: 1206, total: 1206 } },
  };
  // Every screen in both themes; the saved setting is not touched.
  for (const theme of ['dark', 'light']) {
    applyTheme(theme);
    for (const [name, s] of Object.entries(shots)) {
      state = { ...s, theme }; send('state', state);
      await new Promise((r) => setTimeout(r, 400));
      writeFileSync(`${dir}/${theme}-${name}.png`, (await win.webContents.capturePage()).toPNG());
      // The results screen once per tab, since each tab has its own title.
      if (name === 'results') for (const tab of ['keys', 'maybe']) {
        await win.webContents.executeJavaScript(`[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.toLowerCase().startsWith('${tab === 'keys' ? 'private' : 'maybe'}')).click()`);
        await new Promise((r) => setTimeout(r, 300));
        writeFileSync(`${dir}/${theme}-results-${tab}.png`, (await win.webContents.capturePage()).toPNG());
      }
    }
  }
  app.quit();
}

// SEED_GUARD_TEST=notes: runs the real Notes check end to end and prints counts only (no text, no titles, no folders).
async function selfTest() {
  const t = Date.now();
  await access({ notes: true, shots: false });
  await scan({ notes: true, scope: null });
  const tally = {};
  for (const f of state.findings) tally[`${f.kind} ${f.certainty} ${f.words ?? ''}`.trim()] = (tally[`${f.kind} ${f.certainty} ${f.words ?? ''}`.trim()] ?? 0) + 1;
  console.log(JSON.stringify({ notes: state.notesDone, findings: state.findings.length, tally, seconds: Math.round((Date.now() - t) / 1000) }));
  app.quit();
}

// SEED_GUARD_TEST=photos [SEED_GUARD_SINCE=<ISO date>]: what Photos can hand over, then the real screenshot check on
// those dates, through the app so its Photos access applies. Prints counts only.
// SEED_GUARD_TRUTH=<album>: the images that hold a real phrase; each checked image is scored against it by id.
async function photosTest() {
  const since = process.env.SEED_GUARD_SINCE ?? null;
  const t = Date.now();
  const probe = await probePhotos(since);
  console.log(JSON.stringify({ probe, seconds: Math.round((Date.now() - t) / 1000) }));
  if (process.env.SEED_GUARD_PROBE_ONLY) return app.quit();
  const truth = process.env.SEED_GUARD_TRUTH ? await albumIds(process.env.SEED_GUARD_TRUTH) : null;
  const counts = { checked: 0, unavailable: 0, passes: {}, tally: {}, seconds: 0, ...(truth && { phrases: truth.size, score: {} }) };
  const score = (k) => { counts.score[k] = (counts.score[k] ?? 0) + 1; };
  const shots = exportScreenshots(since);
  for (let next = await shots.next(); !next.done; next = await shots.next()) {
    const want = truth?.has(next.value.id);
    if (!next.value.path) { counts.unavailable++; if (want) score('phrase image not readable'); continue; }
    const r = await ocr(next.value.path);
    counts.checked++;
    if (truth) {
      const phrase = r.findings?.some((f) => f.kind === 'seed_phrase' && f.certainty === 'checksum_valid');
      const maybe = r.findings?.some((f) => f.certainty === 'probable');
      score(want ? (phrase ? 'phrase found' : maybe ? 'phrase missed, shown as maybe' : 'phrase missed')
        : phrase ? 'false alarm' : maybe ? 'maybe on an image without a phrase' : r.findings?.length ? 'other finding' : 'quiet');
    }
    counts.passes[r.pass ?? 'error'] = (counts.passes[r.pass ?? 'error'] ?? 0) + 1;
    for (const f of r.findings ?? []) counts.tally[`${f.kind} ${f.certainty} ${f.words ?? ''}`.trim()] = (counts.tally[`${f.kind} ${f.certainty} ${f.words ?? ''}`.trim()] ?? 0) + 1;
  }
  counts.seconds = Math.round((Date.now() - t) / 1000);
  console.log(JSON.stringify(counts));
  app.quit();
}

const headless = process.env.SEED_GUARD_SHOTS || process.env.SEED_GUARD_TEST;
app.setName('Seed Guard');
app.whenReady().then(() => {
  setState(readTheme());
  applyTheme(state.theme);
  createWindow();
  if (process.env.SEED_GUARD_SHOTS) captureScreens(process.env.SEED_GUARD_SHOTS);
  if (process.env.SEED_GUARD_TEST === 'notes') selfTest();
  if (process.env.SEED_GUARD_TEST === 'photos') photosTest().catch((e) => { console.log(JSON.stringify({ error: e.message })); app.quit(); });
  // SEED_GUARD_RECORD=<dir>: records the window while an autopilot clicks through the flow, then quits (src/dev/record.mjs).
  if (process.env.SEED_GUARD_RECORD) import('./dev/record.mjs').then(({ record }) => record(win, process.env.SEED_GUARD_RECORD))
    .catch((e) => console.error('record:', e.message)).finally(() => app.quit());
});
app.on('activate', () => { if (!win) createWindow(); });
app.on('window-all-closed', () => {}); // a running check keeps going with the window closed
app.on('before-quit', () => { worker?.kill(); });
