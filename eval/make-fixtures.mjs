// Renders the eval set: phone-sized screenshots with freshly generated, never-funded secrets, plus look-alikes that must stay quiet.
// Headless Chrome draws each page; truth.json says what each image holds.
import { entropyToMnemonic, generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-fixtures-'));
const PHONE = [393, 852]; // iPhone 15 points; rendered at 3x like a real screenshot
const SANS = "'Helvetica Neue', Arial, sans-serif";
const seed12 = () => generateMnemonic(wordlist, 128);
const seed24 = () => generateMnemonic(wordlist, 256);
const hex = () => crypto.randomBytes(32).toString('hex');
// Thirteen wordlist words whose checksum fails: a near miss that should be reported as "maybe", not as a phrase.
const brokenSeed = () => { const w = entropyToMnemonic(crypto.randomBytes(16), wordlist).split(' '); w[11] = w[11] === 'zoo' ? 'abandon' : 'zoo'; return w.join(' '); };

const grid = (words, cols, cell) => `<div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:10px">${
  words.map((w, i) => `<div style="${cell}"><span style="opacity:.55;margin-right:6px">${i + 1}</span>${w}</div>`).join('')}</div>`;

const cases = [
  ['wallet-12-dark', 'seed', () => { const m = seed12(); return [m, PHONE, `<body style="background:#0e0f13;color:#f2f2f2;font:17px ${SANS};padding:60px 24px">
    <h2>Your recovery phrase</h2><p style="color:#9a9eab">Write down these 12 words in order. Never share them.</p>
    ${grid(m.split(' '), 2, 'background:#1c1e25;border-radius:10px;padding:12px')}</body>`]; }],
  ['wallet-24-light', 'seed', () => { const m = seed24(); return [m, PHONE, `<body style="background:#fff;color:#111;font:15px ${SANS};padding:50px 20px">
    <h3>Secret Recovery Phrase</h3>${grid(m.split(' '), 3, 'border:1px solid #ddd;border-radius:8px;padding:9px')}</body>`]; }],
  ['metamask-style', 'seed', () => { const m = seed12(); return [m, PHONE, `<body style="background:#fff;color:#24272a;font:16px ${SANS};padding:70px 22px">
    <h2 style="text-align:center">Write down your Secret Recovery Phrase</h2><p style="color:#6a737d">This is your only way to recover your wallet.</p>
    ${grid(m.split(' '), 3, 'border:1px solid #bbc0c5;border-radius:20px;padding:8px;text-align:center')}</body>`]; }],
  ['notes-app', 'seed', () => { const m = seed12(); return [m, PHONE, `<body style="background:#fffefb;color:#1c1c1e;font:17px -apple-system,${SANS};padding:70px 20px;line-height:1.5">
    <h2>trust main</h2><p>${m}</p><p>pin 4471</p></body>`]; }],
  ['paper-tilted', 'seed', () => { const m = seed12(); return [m, [800, 700], `<body style="margin:0;background:#6b5a48"><div style="margin:40px;padding:36px;background:#f4ecd8;transform:rotate(-4deg);
    font:30px 'Bradley Hand',cursive;color:#1d2a5a;line-height:1.6">${m.split(' ').map((w, i) => `${i + 1}. ${w}`).join('&nbsp;&nbsp; ')}</div></body>`]; }],
  ['paper-list', 'seed', () => { const m = seed12(); return [m, [600, 900], `<body style="margin:0;background:#3d3a36"><div style="margin:30px;padding:30px 40px;background:#fbfaf4;transform:rotate(1.5deg);
    font:28px 'Noteworthy',cursive;color:#222;line-height:1.55">${m.split(' ').map((w, i) => `${i + 1}. ${w}`).join('<br>')}</div></body>`]; }],
  ['private-key', 'private_key', () => { const k = hex(); return [k, PHONE, `<body style="background:#fff;color:#24272a;font:16px ${SANS};padding:70px 22px;word-break:break-all">
    <h3>Show private key</h3><p style="color:#d73a49">Warning: never disclose this key.</p><p style="font:15px Menlo;border:1px solid #ddd;padding:12px;border-radius:8px">${k}</p></body>`]; }],
  ['broken-phrase', 'probable', () => { const m = brokenSeed(); return [m, PHONE, `<body style="background:#fffefb;color:#1c1c1e;font:17px ${SANS};padding:70px 20px;line-height:1.5">
    <h2>old wallet?</h2><p>${m}</p></body>`]; }],
  ['tx-receipt', 'none', () => [null, PHONE, `<body style="background:#fff;color:#111;font:15px ${SANS};padding:60px 20px;word-break:break-all">
    <h3>Transaction details</h3><p>Status: Success</p><p>Amount: 250 USDT</p><p>Tx hash</p><p style="font:14px Menlo">0x${hex()}</p><p>View on Etherscan</p></body>`]],
  ['chat', 'none', () => [null, PHONE, `<body style="background:#e9edf2;font:16px ${SANS};padding:60px 16px">
    ${['are you coming to the gym tonight? open mat starts at seven', 'yes but I have to pick up a bag of rice and some coffee first',
    'ok, bring the extra belt, I left it in the car last week', 'will do. also the coach said we need to pay for the month before friday',
    'cool, see you there, bring water'].map((t) => `<p style="background:#fff;border-radius:14px;padding:10px 14px;max-width:80%">${t}</p>`).join('')}</body>`]],
  ['settings', 'none', () => [null, PHONE, `<body style="background:#f2f2f7;font:17px ${SANS};padding:60px 16px">
    ${['Wi-Fi', 'Bluetooth', 'Mobile Data', 'Personal Hotspot', 'Notifications', 'Sounds & Haptics', 'Focus', 'Screen Time', 'General', 'Control Centre',
    'Display & Brightness', 'Home Screen', 'Accessibility', 'Wallpaper', 'Battery', 'Privacy & Security'].map((t) => `<div style="background:#fff;padding:12px 14px;border-bottom:1px solid #ddd">${t}</div>`).join('')}</body>`]],
  ['word-list', 'none', () => [null, PHONE, `<body style="background:#fff;font:17px ${SANS};padding:60px 20px">
    <h3>Shopping</h3>${['apple', 'banana', 'bread', 'butter', 'cheese', 'coffee', 'cream', 'egg', 'flour', 'garlic', 'lemon', 'milk', 'onion', 'pepper', 'rice', 'salt', 'sugar', 'tomato']
    .map((t) => `<div>${t}</div>`).join('')}</body>`]],
  // Found on a real library: a numbered list whose items start with wordlist words looked like part of a phrase.
  ['todo-numbered', 'none', () => [null, PHONE, `<body style="background:#fffefb;color:#1c1c1e;font:17px -apple-system,${SANS};padding:70px 20px;line-height:1.7">
    <h2>To do this week</h2>${['Call the bank about the card', 'Buy milk and bread', 'Pay rent', 'Book flights for December', 'Clean the car', 'Return the jacket',
    'Order a pizza for Friday', 'Fix the door handle', 'Water the garden', 'Charge the camera'].map((t, i) => `<div>${i + 1}. ${t}</div>`).join('')}</body>`]],
  ['article', 'none', () => [null, PHONE, `<body style="background:#fff;color:#222;font:16px Georgia,serif;padding:60px 20px;line-height:1.5">
    <h2>How to keep your wallet safe</h2><p>Never store your recovery phrase in a screenshot or a note that syncs to the cloud. Write it on paper,
    keep it somewhere safe, and test the backup before you move real money. Hardware wallets help, but only if you protect the phrase.</p>
    <p>Most losses come from simple mistakes: a photo of the phrase, a shared document, or a fake support agent asking for it.</p></body>`]],
];

const truth = {};
for (const [name, kind, make] of cases) {
  const [secret, [w, h], body] = make();
  const html = path.join(tmp, name + '.html');
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;width:${w}px;min-height:${h}px}</style>${body}`);
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${tmp}`, `--window-size=${w},${h}`,
    `--force-device-scale-factor=${w === PHONE[0] ? 3 : 2}`, `--screenshot=${path.join(dir, name + '.png')}`, 'file://' + html], { stdio: 'ignore' });
  truth[name] = { kind, ...(kind === 'seed' && { mnemonic: secret }), ...(kind === 'private_key' && { key: secret }) };
}
fs.writeFileSync(path.join(dir, 'truth.json'), JSON.stringify(truth, null, 2));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${cases.length} fixtures in ${dir}`);
