// Deterministic secret checks: BIP39 and TON recovery phrases (the checksum decides) and raw private keys.
// Works on OCR blocks (screenshots) and on plain text (notes). Nothing here talks to a model.
import { createHmac, pbkdf2Sync } from 'node:crypto';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

const WORDS = new Set(wordlist);
const BY_PREFIX = new Map(wordlist.map((w) => [w.slice(0, 4), w])); // BIP39: the first 4 letters are unique
const SIZES = [24, 21, 18, 15, 12];
const NUMBER = /^([0-9OoIlL]{1,2})[.)]?$/; // OCR reads 1 as l or L and 0 as O
const GLUED = /^(\d{1,2})[.)]?([a-z]{3,})$/i;
const HINT = /seed|phrase|recovery|mnemonic|wallet|backup|metamask|trust|ledger|phantom|exodus|сид|фраз|кошел/i;
const TX_WORDS = /\btx|hash|transaction|txid|etherscan|bscscan|tronscan|транзакц/i;
const KEY_WORDS = /priv|secret|export|ключ/i;

// Token -> BIP39 word. Exact for typed text; with OCR, a token whose 4-letter prefix is unique and whose length is close also counts.
export function toWord(token, fuzzy = true) {
  const t = token.toLowerCase().replace(/[^a-z]/g, '');
  if (WORDS.has(t)) return t;
  // "words" is the caption on nearly every phrase screen ("12 words", "these 24 words"), not a misread of "word".
  if (!fuzzy || t.length < 4 || t === 'words') return null;
  const w = BY_PREFIX.get(t.slice(0, 4));
  return w && Math.abs(w.length - t.length) <= 2 ? w : null;
}

// TON wallets (Tonkeeper, Tonhub) use the same English wordlist with their own check instead of the BIP39 checksum:
// PBKDF2 over HMAC-SHA512 of the phrase must start with a zero byte. 24 words, no password.
const isTon = (words) => words.length === 24
  && pbkdf2Sync(createHmac('sha512', words.join(' ')).update('').digest(), 'TON seed version', 390, 64, 'sha512')[0] === 0;

export const isPhrase = (words) => validateMnemonic(words.join(' '), wordlist) || isTon(words);

const slotNumber = (token) => {
  const m = token.match(NUMBER);
  return m ? Number(m[1].replace(/[Oo]/g, '0').replace(/[IlL]/g, '1')) : NaN;
};

// Blocks -> tokens in reading order: rows by vertical centre, then left to right.
export function readingOrder(blocks) {
  const items = blocks.filter((b) => b.bbox).map((b) => {
    const [x1, y1, x2, y2] = b.bbox;
    return { text: b.text, x: x1, y: (y1 + y2) / 2, h: y2 - y1 };
  }).sort((a, b) => a.y - b.y);
  const rows = [];
  for (const it of items) {
    const row = rows.at(-1);
    if (row && Math.abs(row.y - it.y) < Math.min(row.h, it.h) * 0.6) row.items.push(it);
    else rows.push({ y: it.y, h: it.h, items: [it] });
  }
  return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x)).flatMap((it) => it.text.split(/\s+/)).filter(Boolean);
}

// A full slot set 1..N for a valid N gives the phrase in order; eight or more slots is a near miss.
function fromSlots(slots) {
  const size = SIZES.find((s) => [...Array(s)].every((_, i) => slots.has(i + 1)));
  if (size) return [...Array(size)].map((_, i) => slots.get(i + 1));
  return slots.size >= 8 ? { partial: slots.size, numbered: true } : null;
}

// Numbered layouts ("1 among", "11.grocery"): the numbers give the order even when OCR reads columns oddly.
function numbered(tokens, fuzzy) {
  const slots = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const glued = tokens[i].match(GLUED);
    const n = glued ? Number(glued[1]) : slotNumber(tokens[i]);
    const word = glued ? toWord(glued[2], fuzzy) : tokens[i + 1] ? toWord(tokens[i + 1], fuzzy) : null;
    if (n >= 1 && n <= 24 && word && !slots.has(n)) slots.set(n, word);
  }
  return fromSlots(slots);
}

// Word boxes: each block's width is shared out among its words by character count.
function wordBoxes(blocks) {
  return blocks.filter((b) => b.bbox).flatMap((b) => {
    const [x1, y1, x2, y2] = b.bbox;
    const words = b.text.split(/\s+/).filter(Boolean);
    const chars = Math.max(1, words.reduce((n, w) => n + w.length + 1, -1));
    let x = x1;
    return words.map((w) => {
      const box = { text: w, x1: x, cy: (y1 + y2) / 2, h: y2 - y1 };
      x += ((w.length + 1) / chars) * (x2 - x1);
      return box;
    });
  });
}

// Handwriting and tilted photos break reading order: pair each number with the nearest word to its right on its own line.
function numberedByPosition(blocks) {
  const boxes = wordBoxes(blocks);
  const slots = new Map();
  for (const b of boxes) {
    const glued = b.text.match(GLUED);
    const n = glued ? Number(glued[1]) : slotNumber(b.text);
    if (!(n >= 1 && n <= 24) || slots.has(n)) continue;
    let word = glued ? toWord(glued[2]) : null;
    if (!glued) {
      const right = boxes.filter((o) => o.x1 > b.x1 && Math.abs(o.cy - b.cy) < Math.max(b.h, o.h) * 0.7 && toWord(o.text))
        .sort((p, q) => p.x1 - q.x1)[0];
      word = right ? toWord(right.text) : null;
    }
    if (word) slots.set(n, word);
  }
  return fromSlots(slots);
}

// Runs of wordlist words, numbers skipped.
function runs(tokens, fuzzy) {
  const out = [];
  let run = [];
  for (const t of tokens) {
    if (/^\d{1,2}[.)]?$/.test(t)) continue;
    const w = toWord(t, fuzzy);
    if (w) run.push(w);
    else { if (run.length) out.push(run); run = []; }
  }
  if (run.length) out.push(run);
  return out;
}

export const longestRun = (tokens, fuzzy = true) => Math.max(0, ...runs(tokens, fuzzy).map((r) => r.length));

// Unnumbered phrases stand alone: a run is tested only when its length is a valid size or at most two words longer
// (a title word), and only at its edges. Windows inside long runs of ordinary words would pass the checksum by chance.
function plain(tokens, fuzzy) {
  let near = 0;
  for (const run of runs(tokens, fuzzy)) {
    for (const s of SIZES) {
      const extra = run.length - s;
      if (extra < 0 || extra > 2) continue;
      for (let i = 0; i <= extra; i++) if (isPhrase(run.slice(i, i + s))) return run.slice(i, i + s);
    }
    if (run.length >= 12 && run.length <= 26) near = Math.max(near, run.length);
  }
  return near ? { partial: near } : null;
}

// OCR reads hex digits as look-alike letters (1 as l, 5 as S). Fixed only in a line that is nearly all hex already.
const LOOKALIKE = { l: '1', I: '1', i: '1', '|': '1', O: '0', o: '0', S: '5', s: '5', Z: '2', z: '2', G: '6', g: '9', q: '9' };
const hexish = (t) => {
  const fixed = t.replace(/[lIi|OoSsZzGgq]/g, (c) => LOOKALIKE[c]);
  return fixed !== t && /^[0-9a-fA-F]+$/.test(fixed) && t.replace(/[^0-9a-fA-F]/g, '').length >= t.length * 0.8 ? fixed : t;
};

// Long hex runs, joined across line breaks (a key wraps on a phone screen).
function hexRuns(lines) {
  const out = [];
  let cur = '';
  for (const line of [...lines, '']) {
    const t = hexish(line.replace(/\s+/g, ''));
    if (/^(0x)?[0-9a-fA-F]+$/.test(t) && t.length >= 8) cur += t;
    else {
      if (cur) out.push(cur);
      cur = '';
      for (const m of t.matchAll(/(?:0x)?[0-9a-fA-F]{64,}/g)) out.push(m[0]);
    }
  }
  return out.filter((h) => h.replace(/^0x/, '').length === 64);
}

function findSecrets({ tokens, lines, blocks, fuzzy }) {
  const text = lines.join('\n');
  const findings = [];
  const tries = [['numbered', () => numbered(tokens, fuzzy)], ['position', () => blocks && numberedByPosition(blocks)], ['plain', () => plain(tokens, fuzzy)]];
  let near = null;
  for (const [how, attempt] of tries) {
    const found = attempt();
    if (Array.isArray(found) && isPhrase(found)) {
      findings.push({ kind: 'seed_phrase', certainty: 'checksum_valid', how, words: found });
      near = null;
      break;
    }
    // A near miss is worth a look when it is numbered like a phrase or sits next to a word like "wallet".
    if (found?.partial && (found.numbered || HINT.test(text)) && !near) near = { kind: 'seed_phrase', certainty: 'probable', how, recognised: found.partial };
  }
  if (near) findings.push(near);
  // 64 hex characters is a private key or a transaction hash; the words around it tell them apart when they can.
  if (!(TX_WORDS.test(text) && !KEY_WORDS.test(text)))
    for (const h of hexRuns(lines)) findings.push({ kind: 'private_key', certainty: 'pattern', value: h });
  return { tokens, findings };
}

export const detect = (blocks) =>
  findSecrets({ tokens: readingOrder(blocks), lines: blocks.map((b) => b.text), blocks, fuzzy: true });

// Plain text (notes): exact words only, there are no OCR typos to forgive.
export const detectText = (text) =>
  findSecrets({ tokens: text.split(/\s+/).filter(Boolean), lines: text.split('\n'), fuzzy: false });

// What a log line may show: never the secret itself.
export const mask = (f) => f.words ? `${f.words.length} words` : f.value ? `${f.value.length} hex chars` : `${f.recognised} wordlist words`;
