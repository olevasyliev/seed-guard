// Theme check: every colour in the window comes from a token, and the light theme defines every token the dark one does.
// Run: node scripts/check-colors.mjs   (exit 1 and a list of problems if anything is off)
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const js = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
const problems = [];

// Token blocks are the `:root { ... }` rules; the first is dark (the default), the one inside the light media query is light.
const blocks = [...css.matchAll(/:root\s*\{([^}]*)\}/g)];
const names = (body) => new Set([...body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const dark = names(blocks[0]?.[1] ?? '');
const lightBlock = css.match(/@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*:root\s*\{([^}]*)\}/);
if (!lightBlock) problems.push('no light token block: @media (prefers-color-scheme: light) { :root { ... } }');
const light = names(lightBlock?.[1] ?? '');
for (const n of dark) if (!light.has(n)) problems.push(`light theme does not set ${n}`);
for (const n of light) if (!dark.has(n)) problems.push(`light theme sets ${n}, which the dark theme does not`);

// Outside the token blocks, no literal colours.
const rest = css.replace(/:root\s*\{[^}]*\}/g, '');
rest.split('\n').forEach((line, i) => {
  for (const m of line.matchAll(COLOR)) problems.push(`styles.css: literal colour ${m[0]} in: ${line.trim().slice(0, 90)}`);
});
js.split('\n').forEach((line, i) => {
  for (const m of line.matchAll(COLOR)) problems.push(`app.js:${i + 1}: literal colour ${m[0]}`);
});

// Every var(--x) used is defined.
for (const m of new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((x) => x[1]))) if (!dark.has(m)) problems.push(`var(${m}) is used but never defined`);

if (problems.length) {
  console.log(`theme check: ${problems.length} problem(s)`);
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log(`theme check: ok, ${dark.size} tokens in both themes, no literal colours outside them`);
