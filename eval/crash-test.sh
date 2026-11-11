#!/bin/bash
# Crash test: runs the eval on the first 10 images of eval/fixtures (`npm run fixtures` first) and kills QVAC's Bare
# worker with SIGBUS mid-run.
# Passes only if all 10 images are still read and scored correctly. Before the fix in src/engine/worker.mjs, every
# image after the crash answered "Model with ID ... not found" and the quiet ones were scored as clean.
# Usage: sh eval/crash-test.sh [seconds before the kill, default 25]
set -u
R=$(cd "$(dirname "$0")/.." && pwd); DELAY=${1:-25}
SUB=$(mktemp -d); trap 'rm -rf "$SUB"' EXIT
mkdir "$SUB/images"
node -e '
  const fs = require("fs"), path = require("path"), [src, dst] = process.argv.slice(1);
  const truth = JSON.parse(fs.readFileSync(path.join(src, "truth.json"), "utf8"));
  const first = Object.fromEntries(Object.entries(truth).slice(0, 10));
  for (const name of Object.keys(first))
    for (const ext of ["png", "jpg"]) if (fs.existsSync(path.join(src, `${name}.${ext}`)))
      fs.copyFileSync(path.join(src, `${name}.${ext}`), path.join(dst, `${name}.${ext}`));
  fs.writeFileSync(path.join(dst, "truth.json"), JSON.stringify(first));
' "$R/eval/fixtures" "$SUB/images"
cd "$R" && source ~/.nvm/nvm.sh >/dev/null && nvm use >/dev/null
node eval/run.mjs "$SUB/images" > "$SUB/run.log" 2>&1 &
EVAL=$!
sleep "$DELAY"
W=$(pgrep -f "$R/src/engine/worker.mjs" | head -1)
B=$(pgrep -P "$W" | head -1)
[ -n "$B" ] || { echo "no Bare worker found under worker $W"; kill $EVAL; exit 2; }
kill -BUS "$B" && echo "sent SIGBUS to the Bare worker ($B) at $(date +%T)"
wait $EVAL
tr '\r' '\n' < "$SUB/run.log" | grep -v '^Preparing' | tail -16
grep -q '^10/10 correct' "$SUB/run.log" && echo "PASS" || { echo "FAIL"; exit 1; }
