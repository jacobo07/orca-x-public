#!/usr/bin/env bash
# Phase-7 remote gate run for federation's named gates, executed on GEX44 inside the dws build clone.
#   dws-federation-gates-remote.sh <sha> <label> <run-dir> [--checkout]
# Writes only under <run-dir> (under the clone's untracked .dws-p7-runs). Never builds, installs or
# restarts anything; gate failures are data. Runs from an untracked copy so the fence's checkout
# cannot remove it. --checkout detaches the clone at <sha> after refusing a dirty tree.
set -u

SHA="${1:-}"
LABEL="${2:-}"
RUN_DIR="${3:-}"
MODE="${4:-}"
CLONE_DIR="/home/kobii/dws-0104-clone"
RUN_ROOT="/home/kobii/dws-0104-clone/.dws-p7-runs"

case "$RUN_DIR" in
  /home/kobii/dws-0104-clone/.dws-p7-runs/*) ;;
  *) echo "usage: <sha> <label> <run-dir under $RUN_ROOT> [--checkout]" >&2; exit 2 ;;
esac
[ -n "$SHA" ] && [ -n "$LABEL" ] || { echo "usage: <sha> <label> <run-dir> [--checkout]" >&2; exit 2; }

mkdir -p "$RUN_DIR"
exec > "$RUN_DIR/summary.txt" 2>&1
printf 'P7_BEGIN label=%s sha=%s\n' "$LABEL" "$SHA"

blocked() {
  printf 'BLOCKED %s %s\n' "$1" "$2"
  printf 'P7_DONE\n'
  : > "$RUN_DIR/DONE"
  exit 0
}

export PATH="/home/kobii/.orca-toolchain/node24/bin:$PATH"
cd "$CLONE_DIR" || blocked clone-missing "cannot enter the build clone"

if [ "$MODE" = "--checkout" ]; then
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    blocked clone-dirty "tracked edits present; refusing to discard them"
  fi
  git cat-file -e "$SHA^{commit}" 2> /dev/null || blocked sha-not-in-clone "object $SHA is absent from the clone"
  git checkout --detach "$SHA" > "$RUN_DIR/checkout.log" 2>&1
fi

REV=$(git rev-parse HEAD)
printf 'REV_BEFORE_GATES %s\n' "$REV"
[ "$REV" = "$SHA" ] || blocked fence-mismatch "clone head $REV differs from $SHA"

NODE_V=$(node -v)
printf 'NODE_VERSION %s\n' "$NODE_V"
case "$NODE_V" in
  v24*) ;;
  *) blocked toolchain "node is $NODE_V" ;;
esac

DISK_BEFORE=$(df -BG --output=avail "$CLONE_DIR" | tail -n 1 | tr -dc '0-9')
printf 'DISK_FREE_GB_BEFORE %s\n' "$DISK_BEFORE"
[ "${DISK_BEFORE:-0}" -ge 5 ] || blocked disk-floor "free space ${DISK_BEFORE:-0} GiB is below 5"

VITEST="node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts"

PROBE_FILE="src/main/runtime/orchestration/orchestration-reset-db.test.ts"
[ -f "$PROBE_FILE" ] || blocked db-probe "probe test $PROBE_FILE is absent"
$VITEST "$PROBE_FILE" > "$RUN_DIR/db-probe.log" 2>&1
RC=$?
printf 'GATE db-probe rc=%s\n' "$RC"
[ "$RC" -eq 0 ] || blocked db-probe "better-sqlite3 probe failed"

node config/scripts/check-orchestration-migration-coherence.mjs > "$RUN_DIR/migration.log" 2>&1
RC=$?
printf 'GATE migration rc=%s\n' "$RC"

node node_modules/typescript/bin/tsc --noEmit -p config/tsconfig.node.json > "$RUN_DIR/tsc-node.log" 2>&1
RC=$?
printf 'GATE tsc-node rc=%s\n' "$RC"
grep 'error TS' "$RUN_DIR/tsc-node.log" | sort -u > "$RUN_DIR/tsc-node-errors.txt"
printf 'TSC_ERRORS %s\n' "$(wc -l < "$RUN_DIR/tsc-node-errors.txt" | tr -d ' ')"

NAMED_FILES="src/cli/index-orchestration.test.ts
src/main/claude/claude-auth-readiness.test.ts
src/main/claude/claude-conversation-driver.test.ts
src/main/claude/claude-conversation-reality.test.ts
src/main/claude/claude-mcp-bridge-reality.test.ts
src/main/codex/codex-conversation-driver-tools.test.ts
src/main/codex/codex-server-request-bridge-tools.test.ts
src/main/ipc/agent-federation.test.ts
src/main/ipc/conversations.test.ts
src/main/runtime/rpc/methods/orchestration-reviews.test.ts
src/main/runtime/rpc/methods/orchestration-runs.test.ts
src/main/runtime/rpc/methods/orchestration-task-delegation.test.ts"
{
  find src/main/runtime/orchestration src/main/conversation -name '*.test.ts'
  for f in $NAMED_FILES; do
    if [ -f "$f" ]; then
      printf '%s\n' "$f"
    else
      printf 'MISSING_TEST_FILE %s\n' "$f" >&2
    fi
  done
} 2> "$RUN_DIR/missing.txt" | sort -u > "$RUN_DIR/vitest-files.txt"
grep '^MISSING_TEST_FILE ' "$RUN_DIR/missing.txt"
FILE_COUNT=$(wc -l < "$RUN_DIR/vitest-files.txt" | tr -d ' ')
printf 'VITEST_FILES %s\n' "$FILE_COUNT"
[ "$FILE_COUNT" -ge 90 ] || blocked file-list-below-floor "$FILE_COUNT files, floor 90"

if [ -n "${ORCA_CLAUDE_REALITY+x}" ]; then
  blocked reality-env-set "ORCA_CLAUDE_REALITY was set in the inherited environment"
fi
unset ORCA_CLAUDE_REALITY
printf 'ORCA_CLAUDE_REALITY unset\n'

$VITEST --reporter=json --outputFile="$RUN_DIR/vitest.json" $(cat "$RUN_DIR/vitest-files.txt") > "$RUN_DIR/vitest.log" 2>&1
RC=$?
printf 'GATE vitest rc=%s\n' "$RC"

: > "$RUN_DIR/vitest-failed.txt"
: > "$RUN_DIR/vitest-skipped-files.txt"
if [ -f "$RUN_DIR/vitest.json" ]; then
  node -e '
var fs = require("fs");
var dir = process.argv[1];
var data = JSON.parse(fs.readFileSync(dir + "/vitest.json", "utf8"));
var failed = {}, skippedFiles = [];
var total = 0, passed = 0, nFailed = 0, skipped = 0;
data.testResults.forEach(function (file) {
  var base = String(file.name).split(/[\\/]/).pop();
  var results = file.assertionResults || [];
  var allSkipped = results.length > 0;
  results.forEach(function (a) {
    total++;
    if (a.status === "passed") passed++;
    else if (a.status === "failed") { nFailed++; failed[a.fullName] = 1; }
    else skipped++;
    if (a.status !== "skipped" && a.status !== "pending" && a.status !== "todo") allSkipped = false;
  });
  if (file.status === "failed" && results.length === 0) failed["suite-failed: " + base] = 1;
  if (allSkipped) skippedFiles.push(base);
});
fs.writeFileSync(dir + "/vitest-failed.txt", Object.keys(failed).sort().join("\n") + "\n");
fs.writeFileSync(dir + "/vitest-skipped-files.txt", skippedFiles.sort().join("\n") + "\n");
console.log("VITEST total=" + total + " passed=" + passed + " failed=" + nFailed + " skipped=" + skipped + " suites=" + data.testResults.length + " skippedFiles=" + skippedFiles.length);
' "$RUN_DIR"
else
  printf 'VITEST total=0 passed=0 failed=0 skipped=0 suites=0 skippedFiles=0\n'
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  printf 'TREE_CLEAN=0\n'
else
  printf 'TREE_CLEAN=1\n'
fi
DISK_AFTER=$(df -BG --output=avail "$CLONE_DIR" | tail -n 1 | tr -dc '0-9')
printf 'DISK_FREE_GB_AFTER %s\n' "$DISK_AFTER"
printf 'P7_DONE\n'
: > "$RUN_DIR/DONE"
exit 0
