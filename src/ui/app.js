// Seed Guard window. Renders the state the main process sends; it never sees a secret, only kinds, counts and places.
const api = window.seedGuard;
const root = document.getElementById('app');
const ui = { notes: true, shots: true, scope: 'year', tab: null, busy: false };
let icons = { note: '', screenshot: '', files: '' };
let state = { screen: 'start' };

// Tiny DOM builder: strings become text nodes, so folder names and dates can never inject markup.
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

const num = (n) => Number(n).toLocaleString('en-US');
const plural = (n, one, many = one + 's') => `${num(n)} ${n === 1 ? one : many}`;
function duration(sec) {
  if (sec < 60) return 'under a minute';
  const m = Math.round(sec / 60);
  return m < 60 ? `about ${m} min` : `about ${Math.floor(m / 60)} h ${m % 60} min`;
}
const size = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'date unknown');

const check = () => {
  const s = h('span', { class: 'tick' });
  s.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2l2.4 2.4 4.6-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return s;
};

// Every hidden word is a bar; widths are decorative, seeded by the finding id, never by the real words.
function bars(f) {
  const n = f.kind === 'private_key' ? 8 : Math.min(f.words || 12, 24);
  let x = (f.id + 7) * 2654435761 % 4294967296;
  const width = () => { x = (x * 1103515245 + 12345) % 2147483648; return 12 + (x % 5) * 4; };
  const lines = [];
  for (let s = 0; s < n; s += 12) lines.push(h('span', { class: 'ln' }, Array.from({ length: Math.min(12, n - s) }, () => h('i', { style: `width:${f.kind === 'private_key' ? 26 : width()}px` }))));
  const cls = f.kind === 'private_key' ? 'phrase key' : f.certainty === 'probable' ? 'phrase maybe' : 'phrase';
  return h('span', { class: cls, role: 'img', 'aria-label': 'hidden' }, lines);
}

const place = (f) => (f.source === 'note' ? `Note, ${day(f.date)} · ${f.where}` : `Screenshot, ${day(f.date)}`);
const icon = (f) => h('img', { src: icons[f.source], alt: f.source === 'note' ? 'Note' : 'Screenshot' });
const foot = (note, ...buttons) => h('div', { class: 'foot' }, note, ...buttons);
const drag = () => h('div', { class: 'drag' });

function start() {
  const choice = (key, img, title, line) => h('button', { class: 'choice', 'aria-pressed': String(ui[key]), onClick: () => { ui[key] = !ui[key]; render(); } },
    h('img', { src: img, alt: '' }), h('span', { class: 'grow' }, h('b', {}, title), h('small', {}, line)), check());
  // A source the prototype does not read yet: shown, so the scope is clear, but it cannot be picked.
  const soon = (img, title, line) => h('div', { class: 'choice soon', 'aria-disabled': 'true' },
    h('img', { src: img, alt: '' }), h('span', { class: 'grow' }, h('b', {}, title), h('small', {}, line)), h('span', { class: 'tag' }, 'Coming soon'));
  const go = async () => { ui.busy = true; render(); await api.access({ notes: ui.notes, shots: ui.shots }); ui.busy = false; };
  return [drag(),
    h('h1', {}, 'Find the ', h('span', { class: 'redact', role: 'img', 'aria-label': 'secrets' }), ' you forgot you saved'),
    h('p', { class: 'lede' }, 'Recovery phrases and private keys left in your notes and screenshots. Checked on this Mac, offline. Nothing is sent anywhere.'),
    h('div', { class: 'choices' },
      choice('notes', icons.note, 'Notes', 'Fast. Reads the text of every note.'),
      choice('shots', icons.screenshot, 'Screenshots', 'Slower. Reads the text in every image.'),
      soon(icons.files, 'Files on this Mac', 'Text files, documents and images in any folder.')),
    foot(h('span', { class: 'note' }, ui.busy ? 'Waiting for your answer in the macOS window…' : 'Works with Wi-Fi off. macOS will ask you to allow access.'),
      h('button', { class: 'btn', disabled: ui.busy || !(ui.notes || ui.shots), onClick: go }, ui.busy ? 'Asking macOS…' : 'Continue'))];
}

function ready() {
  const { counts = {}, errors = {}, estimate = {} } = state;
  const shots = counts.shots;
  const parts = [counts.notes != null && plural(counts.notes, 'note'), shots && plural(shots.all, 'screenshot')].filter(Boolean);
  const total = (counts.notes != null ? estimate.notes : 0) + (shots ? estimate[ui.scope] : 0);
  const opt = (scope, label, n) => h('button', { class: 'opt', role: 'radio', 'aria-checked': String(ui.scope === scope), onClick: () => { ui.scope = scope; render(); } },
    h('span', { class: 'radio' }), h('span', {}, label), h('span', { class: 'num' }, num(n)), h('span', { class: 'time' }, duration(estimate[scope])));
  const rows = [];
  if (ui.notes) rows.push(h('div', { class: 'row' }, h('img', { src: icons.note, alt: '' }), h('b', {}, 'Notes'),
    h('span', { class: 'num' }, counts.notes != null ? num(counts.notes) : ''), h('span', { class: 'time' }, counts.notes != null ? duration(estimate.notes) : ''),
    errors.notes && h('span', { class: 'warn' }, 'No access. Allow it in System Settings, Privacy & Security, Automation.')));
  if (ui.shots) rows.push(h('div', { class: 'row', role: 'radiogroup', 'aria-label': 'Screenshots' }, h('img', { src: icons.screenshot, alt: '' }), h('b', {}, 'Screenshots'), h('span'), h('span'),
    shots ? [opt('year', 'Last 12 months', shots.year), opt('all', 'All of them', shots.all)]
      : h('span', { class: 'warn' }, errors.shots ? 'No access to Photos. Allow it in System Settings, Privacy & Security, Photos.' : 'No screenshots in Photos.')));
  if (ui.shots && shots && state.download > 0) rows.push(h('div', { class: 'row' }, h('span'), h('b', {}, 'QVAC models, first run only'),
    h('span', { class: 'num' }, size(state.download)), h('span', { class: 'time' }, 'download once')));
  const canStart = counts.notes != null || (shots && shots[ui.scope] > 0);
  return [drag(),
    h('h1', { class: 's' }, parts.length ? parts.join(' and ') : 'Nothing to check yet'),
    h('p', { class: 'lede' }, canStart ? 'Here is how long the check takes on this Mac.' : 'Seed Guard needs access to at least one of them.'),
    h('div', { class: 'rows' }, rows, canStart && h('div', { class: 'total' }, h('span', {}, 'Total'), h('span', {}, duration(total)))),
    foot(h('span', { class: 'note' }, 'Keep the Mac plugged in. You can close this window.'),
      h('button', { class: 'btn second', onClick: () => api.restart() }, 'Back'),
      h('button', { class: 'btn', disabled: !canStart, onClick: () => api.scan({ notes: counts.notes != null, scope: shots ? ui.scope : null }) }, 'Start check'))];
}

function checking() {
  const p = state.progress ?? { phase: 'notes', done: 0, total: 0 };
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const findings = state.findings ?? [];
  const models = p.phase === 'models';
  return [drag(),
    h('h1', { class: 's' }, models ? 'Preparing models' : p.phase === 'notes' ? 'Checking notes' : 'Checking screenshots'),
    h('div', { class: 'track', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: `width:${pct}%` })),
    h('div', { class: 'meta' },
      h('span', {}, models ? (p.total ? `${size(p.done)} of ${size(p.total)}` : 'Looking for the models…')
        : p.phase === 'notes' ? `Folder ${p.done} of ${p.total}` : `${num(p.done)} of ${num(p.total)}`),
      h('span', {}, models ? p.label ?? '' : p.phase === 'shots' && p.done > 2 ? `${duration(p.left)} left` : '')),
    state.notesDone && h('div', { class: 'done' }, h('img', { src: icons.note, alt: '' }), h('span', {}, `Notes done: ${num(state.notesDone.checked)} checked`)),
    h('div', { class: 'found' }, h('h2', {}, `Found so far: ${num(findings.length)}`),
      findings.slice(-3).reverse().map((f) => h('div', { class: 'item' }, icon(f), h('span', { class: 'src' }, place(f)), bars(f),
        h('span', { class: 'what' }, f.kind === 'private_key' ? 'key' : `${f.words} words`)))),
    foot(h('span', { class: 'note' }, models ? 'A one-time download from the QVAC model registry. After it, Wi-Fi can be off.' : 'Running on this Mac, Wi-Fi can be off. You can close this window.'),
      p.phase === 'shots' && h('button', { class: 'btn second', onClick: () => api.pause(!state.paused) }, state.paused ? 'Resume' : 'Pause'))];
}

// Each tab has its own title and lede, so the heading always says what the list under it is.
const GROUPS = [
  { key: 'seeds', label: 'Recovery phrases', test: (f) => f.kind === 'seed_phrase' && f.certainty === 'checksum_valid',
    title: (n) => `${plural(n, 'recovery phrase')} found on this Mac`,
    lede: 'Anyone who reads one can empty that wallet. Notes and Photos sync to iCloud, so they are probably there too.',
    todo: ['For each one:', ' move the funds to a new wallet, then delete it and empty Recently Deleted.'] },
  { key: 'keys', label: 'Private keys', test: (f) => f.kind === 'private_key',
    title: (n) => `${plural(n, 'possible private key')} found on this Mac`,
    lede: 'Strings of 64 hex characters, the shape of a wallet’s private key. A transaction hash looks the same and is safe to keep, so open each one to see.',
    todo: ['If it is a key:', ' move the funds to a new wallet, then delete it.'] },
  { key: 'maybe', label: 'Maybe', test: (f) => f.kind === 'seed_phrase' && f.certainty === 'probable',
    title: (n) => `${plural(n, 'possible recovery phrase')} to look at`,
    lede: 'Recovery-phrase words laid out like a phrase, but the checksum does not match. Could be a phrase with a typo, or part of one.',
    todo: ['Worth a look:', ' if it is a real phrase, move the funds to a new wallet, then delete it.'] },
];

function results() {
  const findings = state.findings ?? [];
  const groups = GROUPS.map((g) => ({ ...g, items: findings.filter(g.test) })).filter((g) => g.items.length);
  if (!groups.length) return clean();
  const tab = groups.find((g) => g.key === ui.tab) ?? groups[0];
  const onlyMaybe = groups.length === 1 && tab.key === 'maybe';
  return [drag(),
    h('h1', { class: 's' }, tab.title(tab.items.length)),
    h('p', { class: 'lede wide' }, onlyMaybe && 'No complete recovery phrase or key was found. ', tab.lede,
      state.modelsFailed && ' Screenshots were not checked: the models could not be downloaded.', notRead()),
    h('div', { class: 'tabs', role: 'tablist' }, groups.map((g) => h('button', { class: 'seg', role: 'tab', 'aria-selected': String(g === tab), onClick: () => { ui.tab = g.key; render(); } },
      g.label, h('em', {}, num(g.items.length))))),
    h('div', { class: 'list' },
      tab.items.map((f) => h('div', { class: 'item' }, icon(f), h('span', { class: 'src', title: place(f) }, place(f)), bars(f), h('button', { class: 'open', onClick: () => api.open(f.id) }, 'Open')))),
    h('div', { class: 'todo' }, h('b', {}, tab.todo[0]), tab.todo[1]),
    foot(h('span', { class: 'spacer' }), h('button', { class: 'btn second', onClick: () => api.restart() }, 'Check again'))];
}

// Screenshots Photos could not hand over are named, never counted as checked.
const notRead = () => state.progress?.missing ? ` ${plural(state.progress.missing, 'screenshot')} could not be read and were not checked.` : null;

function clean() {
  const rows = [];
  if (state.notesDone) rows.push(h('div', { class: 'row' }, h('img', { src: icons.note, alt: '' }), h('b', {}, 'Notes'), h('span', { class: 'num' }, num(state.notesDone.checked)), h('span', { class: 'time' }, 'checked')));
  if (state.progress?.phase === 'shots') rows.push(h('div', { class: 'row' }, h('img', { src: icons.screenshot, alt: '' }), h('b', {}, ui.scope === 'year' ? 'Screenshots, last 12 months' : 'Screenshots'), h('span', { class: 'num' }, num(state.progress.done - (state.progress.missing ?? 0))), h('span', { class: 'time' }, 'checked')));
  const missed = state.modelsFailed ? ' Screenshots were not checked: the models could not be downloaded. Check the connection and try again.'
    : state.notesDone?.failed ? ' Notes could not be read this time.'
    : state.notesDone?.skipped || state.notesDone?.brokenFolders ? ' A few locked or very large notes could not be read.' : null;
  return [drag(),
    h('h1', {}, 'Nothing exposed'),
    h('p', { class: 'lede' }, 'No recovery phrases or private keys in what was checked.', missed, notRead()),
    h('div', { class: 'rows' }, rows),
    foot(h('span', { class: 'spacer' }), h('button', { class: 'btn', onClick: () => api.restart() }, 'Done'))];
}

// Light or dark: one switch, same corner on every screen. The main process applies and remembers it.
const MOON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 10.1A5.6 5.6 0 0 1 5.9 2.8a5.6 5.6 0 1 0 7.3 7.3z" fill="currentColor"/></svg>';
const SUN = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="currentColor"/><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 1.3v1.4M8 13.3v1.4M1.3 8h1.4M13.3 8h1.4M3.3 3.3l1 1M11.7 11.7l1 1M3.3 12.7l1-1M11.7 4.3l1-1"/></g></svg>';
function themeSwitch() {
  const light = state.theme === 'light';
  const part = (on, svg) => { const s = h('span', { class: on ? 'on' : null }); s.innerHTML = svg; return s; };
  return h('div', { class: 'theme-bar' },
    state.themeError && h('small', {}, state.themeError),
    h('button', { class: 'theme', role: 'switch', 'aria-label': 'Light appearance', 'aria-checked': String(light), title: light ? 'Switch to dark' : 'Switch to light',
      onClick: () => api.theme(light ? 'dark' : 'light') }, part(!light, MOON), part(light, SUN)));
}

const SCREENS = { start, ready, checking, results };
function render() {
  const focused = document.activeElement?.classList.contains('theme');
  root.replaceChildren(...[(SCREENS[state.screen] ?? start)(), themeSwitch()].flat(Infinity).filter(Boolean));
  if (focused) root.querySelector('.theme')?.focus(); // keep keyboard focus on the switch after it redraws
}

api.onState((s) => { if (s.screen !== state.screen) ui.tab = null; state = s; render(); });
Promise.all([api.icons(), api.state()]).then(([i, s]) => { icons = i; state = s; render(); });
