#!/usr/bin/env bash
# PostToolUse hook: lint-fix the edited TypeScript file and typecheck its workspace.
# Runs async; exits 2 (with output) only on failure, which wakes the model.

set -u
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# No jq on this machine — parse the hook's stdin JSON with node, and normalise
# Windows backslashes there too (bash pattern substitution mangles them).
f=$(node -e '
let s = "";
process.stdin.on("data", d => (s += d)).on("end", () => {
  try {
    const j = JSON.parse(s);
    const p = (j.tool_response && j.tool_response.filePath) || (j.tool_input && j.tool_input.file_path) || "";
    process.stdout.write(p.replace(/\\/g, "/"));
  } catch { process.stdout.write(""); }
})') || exit 0

[ -n "$f" ] || exit 0

case "$f" in
  *.ts | *.tsx) ;;
  *) exit 0 ;;
esac
case "$f" in
  */packages/backend/*) proj=packages/backend/tsconfig.json ;;
  */packages/frontend/*) proj=packages/frontend/tsconfig.json ;;
  *) exit 0 ;;
esac

lint_out=$(npx eslint --fix "$f" 2>&1)
lint_rc=$?

tsc_out=$(npx tsc --noEmit -p "$proj" 2>&1)
tsc_rc=$?

[ $lint_rc -eq 0 ] && [ $tsc_rc -eq 0 ] && exit 0

echo "Automated check failed for ${f##*/}:"
[ $lint_rc -ne 0 ] && { echo "--- eslint ---"; echo "$lint_out" | head -40; }
[ $tsc_rc -ne 0 ] && { echo "--- tsc ($proj) ---"; echo "$tsc_out" | head -40; }
exit 2
