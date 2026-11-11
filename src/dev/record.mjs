// Demo recording for the video (SEED_GUARD_RECORD=<dir>): the window's own frames as JPEGs named by their time in ms,
// and an autopilot that clicks through the real flow with a drawn cursor. Needs no screen-recording permission.
// Writes <dir>/timeline.json with when each step happened, for the edit. Nothing here runs unless the variable is set.
import fs from 'node:fs';
import path from 'node:path';

const FRAME_MS = 33; // ~30 fps is enough for a UI; frames are only painted when something changes

// Runs inside the page: a macOS-style arrow drawn above everything, moved with a CSS transition.
const CURSOR = `(() => {
  if (window.__cursor) return;
  const c = document.createElement('div');
  c.style.cssText = 'position:fixed;left:600px;top:460px;width:20px;height:28px;z-index:99999;pointer-events:none;' +
    'transition:left .75s cubic-bezier(.45,0,.2,1),top .75s cubic-bezier(.45,0,.2,1),transform .12s;transform-origin:2px 2px';
  c.innerHTML = '<svg width="20" height="28" viewBox="0 0 20 28"><path d="M2 2v20.5l5.2-5 3.6 8.2 3.3-1.4-3.5-8.1h7.1z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.body.append(c);
  window.__cursor = c;
})()`;

// The enabled button whose text contains `text`: where to point at it (null until it is on screen), and a click.
const button = (text) => `[...document.querySelectorAll('button')].find((x) => x.textContent.includes(${JSON.stringify(text)}) && !x.disabled)`;
const where = (text) => `(() => {
  const b = ${button(text)};
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.left + Math.min(r.width / 2, 120)), y: Math.round(r.top + r.height / 2) };
})()`;
const press = (text) => `(() => { const b = ${button(text)}; b?.click(); return !!b; })()`;

export function record(win, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const now = () => Date.now() - t0;
  const timeline = [];
  const mark = (step) => { timeline.push({ step, ms: now() }); fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(timeline, null, 1)); };
  let last = -FRAME_MS;
  win.setAlwaysOnTop(true, 'floating'); // a covered window stops painting
  win.webContents.setBackgroundThrottling(false);
  win.webContents.beginFrameSubscription(false, (image) => {
    const ms = now();
    if (ms - last < FRAME_MS) return;
    last = ms;
    fs.writeFile(path.join(dir, `${String(ms).padStart(8, '0')}.jpg`), image.toJPEG(92), () => {});
  });

  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (test, timeout = 20 * 60e3) => { const end = Date.now() + timeout; while (!(await test())) { if (Date.now() > end) throw new Error('autopilot timed out'); await wait(250); } };
  const screen = async () => (await js('window.seedGuard.state()')).screen;
  // A step whose button never shows up (say, no "Maybe" in this run) is skipped after `timeout`.
  const moveTo = async (text, timeout = 30e3) => {
    let p = null;
    try { await until(async () => (p = await js(where(text))), timeout); } catch { return false; }
    await js(`Object.assign(window.__cursor.style, { left: '${p.x}px', top: '${p.y}px' })`);
    await wait(900);
    return true;
  };
  const click = async (text, timeout) => {
    if (!(await moveTo(text, timeout))) return false;
    await js(`window.__cursor.style.transform = 'scale(.82)'`);
    await wait(140);
    await js(press(text));
    await js(`window.__cursor.style.transform = ''`);
    return true;
  };
  const park = () => js(`Object.assign(window.__cursor.style, { left: '676px', top: '486px' })`);

  return (async () => {
    if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
    await until(() => js(`!!document.querySelector('.choices img[src^="data:"]')`), 30e3); // icons are in
    await js(CURSOR);
    mark('start');
    await wait(2500);
    await moveTo('Notes'); await moveTo('Screenshots');
    await click('Continue'); mark('continue');
    await until(async () => (await screen()) === 'ready', 60e3); mark('ready');
    await wait(3500);
    await click('Start check'); mark('check');
    await park();
    await until(async () => (await screen()) === 'checking', 30e3);
    await until(() => js(`(document.querySelector('h1')?.textContent ?? '').includes('screenshots')`)); mark('screenshots');
    await until(async () => (await screen()) === 'results'); mark('results');
    await wait(3500);
    await moveTo('Open'); mark('open'); await wait(1500);
    // The screenshots sit below the notes in the list: scroll down to them and back.
    await js(`document.querySelector('.list')?.scrollTo({ top: 1e4, behavior: 'smooth' })`); mark('scroll'); await wait(2600);
    await js(`document.querySelector('.list')?.scrollTo({ top: 0, behavior: 'smooth' })`); await wait(1200);
    if (await click('Private keys', 3000)) { mark('keys'); await wait(2800); }
    if (await click('Maybe', 3000)) { mark('maybe'); await wait(2800); }
    if (await click('Recovery phrases', 3000)) { mark('phrases'); await wait(1800); }
    mark('end');
    win.webContents.endFrameSubscription();
    await wait(500);
  })();
}
