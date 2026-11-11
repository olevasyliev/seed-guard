// Apple Notes through the Notes app (JXA). Note text stays in memory and is never written to disk.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_SCOPE } from './scope.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../notes/notes.jxa.js');

// Resolves with the number of lines that did not parse: a broken folder is counted, never fatal.
function run(cmd, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn('osascript', ['-l', 'JavaScript', SCRIPT, cmd, ...(DEMO_SCOPE ? [DEMO_SCOPE] : [])]);
    let err = '';
    let broken = 0;
    p.stderr.on('data', (d) => { err += d; });
    createInterface({ input: p.stdout, crlfDelay: Infinity }).on('line', (l) => {
      let line;
      try { line = JSON.parse(l); } catch { broken++; return; }
      onLine(line);
    });
    p.on('close', (code) => (code === 0 ? resolve(broken) : reject(new Error(err.trim() || `osascript exited ${code}`))));
  });
}

// Asking for the count is also what makes macOS show the "control Notes" prompt.
export async function countNotes() {
  let count = 0;
  await run('count', (l) => { count = l.count; });
  return count;
}

const toText = (html) => html
  .replace(/<(br|\/div|\/p|\/li|\/h\d|\/tr)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');

// Calls onNote({ id, folder, created, modified, text }) once per distinct note, onFolder(i, total) as folders finish.
export async function readNotes(onNote, onFolder) {
  const seen = new Set();
  let skipped = 0;
  const brokenFolders = await run('export', (f) => {
    skipped += f.skipped ?? 0;
    f.ids.forEach((id, k) => {
      if (seen.has(id)) return; // a note can be listed under a folder and its parent
      seen.add(id);
      onNote({ id, folder: f.folder, created: f.created[k], modified: f.modified[k], text: toText(f.bodies[k] ?? '') });
    });
    onFolder(f.index + 1, f.folders);
  });
  return { notes: seen.size, skipped, brokenFolders };
}

export function openNote(id) {
  spawn('osascript', ['-l', 'JavaScript', '-e', `const N = Application('Notes'); N.activate(); N.show(N.notes.byId(${JSON.stringify(id)}))`]);
}
