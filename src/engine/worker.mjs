// OCR worker: QVAC models run in their own process so the window stays responsive.
// Gets image paths, answers with findings only: kinds and word counts, never the recognised text.
import {
  completion, downloadAsset, getModelInfo, loadModel, MMPROJ_QWEN3_5_4B_MULTIMODAL_Q8_0, ocr,
  OCR_CRAFT, OCR_DOCTR, OCR_DOCTR_1, OCR_LATIN, QWEN3_5_4B_MULTIMODAL_Q4_K_M,
} from '@qvac/sdk';
import { detect, isPhrase, longestRun, readingOrder, toWord } from './detect.mjs';

const CONFIG = { langList: ['en'], magRatio: 1, defaultRotationAngles: [], contrastRetry: false, lowConfidenceThreshold: 0.5, recognizerBatchSize: 8 };
const HINT = /seed|phrase|recovery|mnemonic|private|secret|wallet|backup|keystore|passphrase/i;
let ocrModels;
let vision;
let preparing = null;

// Every file the scan can need, by the name the user sees. Each OCR model is a detector plus a recogniser.
// The handwriting model is downloaded here too, though it is loaded only on a near miss: otherwise the first
// handwritten phrase would stop the scan on a silent 3 GB download. Downloading is not loading; memory stays free.
const FILES = [
  ['Fast text reader', OCR_DOCTR_1], ['Fast text reader', OCR_DOCTR],
  ['Exact text reader', OCR_CRAFT], ['Exact text reader', OCR_LATIN],
  ['Handwriting reader', QWEN3_5_4B_MULTIMODAL_Q4_K_M], ['Handwriting reader', MMPROJ_QWEN3_5_4B_MULTIMODAL_Q8_0],
];

// Bytes still to download; zero once the models are in the QVAC cache.
async function missing() {
  const cached = await Promise.all(FILES.map(([, m]) => getModelInfo({ name: m.name }).then((i) => i.isCached, () => false)));
  return FILES.reduce((n, [, m], i) => n + (cached[i] ? 0 : m.expectedSize), 0);
}

// Downloads what is missing, reporting { label, done, total } in bytes across all files, a few times a second.
async function download(report) {
  const total = FILES.reduce((n, [, m]) => n + m.expectedSize, 0);
  let before = 0;
  let sent = 0;
  for (const [label, m] of FILES) {
    report({ label, done: before, total });
    await downloadAsset({ assetSrc: m, onProgress: (p) => {
      if (Date.now() - sent < 250) return;
      sent = Date.now();
      report({ label, done: before + p.downloaded, total });
    } });
    before += m.expectedSize;
  }
  report({ label: null, done: total, total });
}

const loadOcr = () => (ocrModels ??= Promise.all([
  loadModel({ modelSrc: OCR_DOCTR, modelConfig: CONFIG }), // fast pass: ~1 s, misreads some characters
  loadModel({ modelSrc: OCR_LATIN, modelConfig: CONFIG }), // exact pass: several seconds, only for suspicious images
]));
// Loaded only when an image needs it: ~3 GB in memory, ~10 s per image.
const loadVision = () => (vision ??= loadModel({
  modelSrc: QWEN3_5_4B_MULTIMODAL_Q4_K_M,
  modelConfig: { ctx_size: 4096, projectionModelSrc: MMPROJ_QWEN3_5_4B_MULTIMODAL_Q8_0 },
}));

const read = async (modelId, image) => ocr({ modelId, image, options: { paragraph: false } }).blocks;

// Fast pass decides whether the image is worth the exact pass: a run of wordlist words, numbered items, a long hex run or a telling word.
// Menus and lists of everyday words make runs of five to seven with OCR's forgiving match, so the bar sits above that.
function suspicious(blocks) {
  const tokens = readingOrder(blocks);
  const numbers = tokens.filter((t) => /^\d{1,2}[.)]?([a-z]{3,})?$/i.test(t) || /^[0-9OIlL]{1,2}[.)]$/.test(t)).length;
  return longestRun(tokens) >= 10 || longestRun(tokens, false) >= 6 || numbers >= 6
    || /[0-9a-f]{24,}/i.test(tokens.join('')) || tokens.some((t) => HINT.test(t));
}

// Handwriting and tilted photos of a screen defeat OCR more often than not. The vision model reads the list; the checksum still decides.
// It returns each word with its number and the order comes from the numbers: asked for the words in order, it reads
// a tilted grid row by row and the checksum fails.
async function readWithVision(image) {
  const modelId = await loadVision();
  const pair = { type: 'object', additionalProperties: false, required: ['n', 'word'], properties: { n: { type: 'integer' }, word: { type: 'string' } } };
  const run = completion({
    modelId, stream: false, generationParams: { reasoning_budget: 0, temp: 0 },
    responseFormat: { type: 'json_schema', json_schema: { name: 'pairs', schema: {
      type: 'object', additionalProperties: false, required: ['pairs'], properties: { pairs: { type: 'array', items: pair } } } } },
    history: [{ role: 'user', attachments: [{ path: image }],
      content: 'This image may show a recovery phrase: 12 to 24 English words, numbered or not, on a screen, on paper or in a photo of a screen. List each word with its number as shown; if the words are not numbered, number them in reading order starting at 1. Lowercase words. If there is no such list, return an empty array.' }],
  });
  const final = await run.final;
  const pairs = (JSON.parse(final.contentText ?? final.content).pairs ?? []).sort((a, b) => a.n - b.n);
  const words = pairs.filter((p, i) => i === 0 || p.n !== pairs[i - 1].n).map((p) => toWord(String(p.word)));
  if (words.length >= 12 && words.every(Boolean) && isPhrase(words)) return { words };
  // Phrase-shaped: twelve or more items, nearly all wordlist words. A short list or everyday words is not a phrase.
  return { shaped: words.length >= 12 && words.filter(Boolean).length >= words.length * 0.8 };
}

const summary = (findings) => findings.map(({ kind, certainty, words, how, recognised }) => ({ kind, certainty, how, words: words?.length ?? recognised }));

async function scan(image) {
  await preparing; // a scan sent during the download waits for it rather than fetching the same files itself
  const [fast, exact] = await loadOcr();
  const t = Date.now();
  const quick = await read(fast, image);
  const first = detect(quick).findings;
  if (first.some((f) => f.certainty === 'checksum_valid')) return { findings: summary(first), pass: 'fast', ms: Date.now() - t };
  if (!suspicious(quick)) return { findings: [], pass: 'fast', ms: Date.now() - t };
  const { findings } = detect(await read(exact, image));
  // The exact pass reads photos of a screen worse than the fast one at times: a near miss from either pass goes to vision.
  const near = findings.find((f) => f.certainty === 'probable') ?? first.find((f) => f.certainty === 'probable');
  if (near) {
    const { words, shaped } = await readWithVision(image);
    const rest = findings.filter((f) => f !== near);
    if (words) return { findings: summary([{ kind: 'seed_phrase', certainty: 'checksum_valid', how: 'vision', words }, ...rest]), pass: 'vision', ms: Date.now() - t };
    // Eight numbered items are enough to ask the vision model, not enough to show a "maybe": a numbered near miss
    // stays only if the model read a phrase-shaped list. Unnumbered near misses already needed a word like "wallet".
    const numberedMiss = near.how !== 'plain';
    return { findings: summary(numberedMiss && !shaped ? rest : [near, ...rest]), pass: 'vision-no', ms: Date.now() - t };
  }
  return { findings: summary(findings), pass: 'exact', ms: Date.now() - t };
}

// { id, image } scans one image; { id, prepare: 'check' } answers how many bytes are missing;
// { id, prepare: 'download' } fetches them, with { models: progress } messages on the way.
process.on('message', async ({ id, image, prepare }) => {
  try {
    if (prepare === 'check') return process.send({ id, missing: await missing() });
    if (prepare === 'download') {
      preparing ??= download((models) => process.send({ models })).finally(() => { preparing = null; });
      await preparing;
      return process.send({ id, ready: true });
    }
    try {
      process.send({ id, ...(await scan(image)) });
    } catch (e) {
      // When QVAC's Bare worker dies, the SDK starts a new one without the models the old one held, and every call
      // answers "Model with ID … not found". Forget the loaded models, load them again and retry this image once.
      if (!/exited mid-request|not found/i.test(String(e?.message ?? e))) throw e;
      ocrModels = vision = null;
      process.send({ id, ...(await scan(image)), recovered: true });
    }
  } catch (e) {
    process.send({ id, error: String(e?.message ?? e) });
  }
});
