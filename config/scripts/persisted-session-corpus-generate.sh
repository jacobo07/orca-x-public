#!/usr/bin/env bash
# Materialise an old Orca tree with `git archive`, run that era's OWN Store to write one workspace
# session, and emit the bytes as an immutable fixture plus a provenance sidecar.
#
# Usage:
#   config/scripts/persisted-session-corpus-generate.sh --era <name> --sha <commit> --floor yes|no \
#       --out <fixture root> --work <scratch dir outside the repo>
#
#   --era    fixture directory name, e.g. main-49b1415e7
#   --sha    commit whose writer is exercised (must be reachable in this repository)
#   --floor  whether the caller wants the era to count toward the corpus floor; the sidecar only keeps
#            `countsTowardFloor: true` when the written session also holds >=3 terminal tabs across
#            >=2 worktrees and a split layout of >=2 leaves
#   --out    receives <out>/<era>/{orca-data.json,provenance.json}
#   --work   scratch root; <work>/<era>/ is created and left for the caller to remove
#
# Exit codes: 0 fixture written; 2 usage / refused path; 3 ERA_UNREACHABLE (sha not in this repo);
# 4 ERA_DROPPED (the era could not be materialised or its writer failed; no fixture written).
# Lines on stdout: LOCK_DRIFT, ERA_RESULT, ERA_DROPPED, ERA_UNREACHABLE. Generator log: <work>/<era>/run.log.
# Needs node, git, tar, sha256sum and this checkout's node_modules (used read-only, never installed into).
set -u

usage() {
  sed -n '2,20p' "$0" >&2
  exit 2
}

ERA=""
SHA=""
FLOOR=""
OUT=""
WORK=""
GENERATOR_ARGS="$*"
while [ $# -gt 0 ]; do
  case "$1" in
    --era) ERA=${2:-}; shift 2 ;;
    --sha) SHA=${2:-}; shift 2 ;;
    --floor) FLOOR=${2:-}; shift 2 ;;
    --out) OUT=${2:-}; shift 2 ;;
    --work) WORK=${2:-}; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$ERA" ] && [ -n "$SHA" ] && [ -n "$OUT" ] && [ -n "$WORK" ] || usage
case "$FLOOR" in yes | no) ;; *) usage ;; esac
# Why: "." and ".." pass the character class but make ERA_DIR the work dir or its parent, so writes land outside the per-era directory.
case "$ERA" in *[!A-Za-z0-9._-]* | "" | . | ..) echo "refused: bad era name" >&2; exit 2 ;; esac

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel) || exit 2
WRITER_DIR="$REPO/tests/fixtures/persisted-sessions/era-writer"
mkdir -p "$WORK" || exit 2
WORK_ABS=$(cd "$WORK" && pwd -P)
REPO_ABS=$(cd "$REPO" && pwd -P)
case "$WORK_ABS/" in "$REPO_ABS"/*) echo "refused: --work is inside the repository" >&2; exit 2 ;; esac

if ! git -C "$REPO" cat-file -e "$SHA^{commit}" 2> /dev/null; then
  echo "ERA_UNREACHABLE $ERA sha=$SHA"
  exit 3
fi
FULL_SHA=$(git -C "$REPO" rev-parse "$SHA^{commit}")

ERA_DIR="$WORK_ABS/$ERA"
TREE="$ERA_DIR/tree"
USERDATA="$ERA_DIR/userdata"
# Why: the Store derives default settings (workspaceDir) from os.homedir(); a synthetic HOME keeps host paths out of the bytes.
SYNTHETIC_HOME=/synthetic/home
LOG="$ERA_DIR/run.log"
rm -rf "$ERA_DIR"
mkdir -p "$TREE" "$USERDATA" || exit 2
: > "$LOG"

drop() {
  echo "ERA_DROPPED $ERA reason=$1"
  exit 4
}

PATHS=()
for p in src config package.json tsconfig.json; do
  git -C "$REPO" cat-file -e "$FULL_SHA:$p" 2> /dev/null && PATHS+=("$p")
done
# Why: an old tsconfig.json may only reference sibling tsconfig*.json files that Vite then fails to parse.
for p in $(git -C "$REPO" ls-tree --name-only "$FULL_SHA" | grep -E '^tsconfig[A-Za-z0-9._-]*\.json$'); do
  case " ${PATHS[*]} " in *" $p "*) ;; *) PATHS+=("$p") ;; esac
done
[ ${#PATHS[@]} -gt 0 ] || drop "no source paths at $FULL_SHA"
git -C "$REPO" archive "$FULL_SHA" -- "${PATHS[@]}" | tar -x -C "$TREE" >> "$LOG" 2>&1 || drop "git archive failed"
ln -s "$REPO/node_modules" "$TREE/node_modules"

ERA_LOCK=$(git -C "$REPO" show "$FULL_SHA:pnpm-lock.yaml" 2> /dev/null | sha256sum | cut -c1-16)
CUR_LOCK=$(sha256sum "$REPO/pnpm-lock.yaml" | cut -c1-16)
echo "LOCK_DRIFT era=$ERA era_prefix=$ERA_LOCK current=$CUR_LOCK"

cp "$WRITER_DIR/era-session-writer.ts" "$TREE/era-session-writer.test.ts"

(
  cd "$TREE" || exit 1
  ERA_NAME="$ERA" ERA_TREE="$TREE" ERA_USERDATA="$USERDATA" HOME="$SYNTHETIC_HOME" \
    timeout 600 node "$REPO/node_modules/vitest/vitest.mjs" run --root "$TREE" \
    --config "$WRITER_DIR/era-vitest.config.mjs"
) >> "$LOG" 2>&1
RC=$?
if [ "$RC" != 0 ] || [ ! -s "$USERDATA/orca-data.json" ] || [ ! -s "$USERDATA/expected.json" ]; then
  REASON=$(grep -m1 -E 'Error|error' "$LOG" | tr -d '\r' | cut -c1-240)
  drop "rc=$RC ${REASON:-no error line}"
fi

# A fixture that names this host (scratch tree, invoking user's home) is refused, never edited.
for needle in "$WORK_ABS" "${HOME:-/nonexistent-home}" "$REPO_ABS"; do
  if grep -qF -- "$needle" "$USERDATA/orca-data.json" "$USERDATA/expected.json"; then
    drop "host path in output ($needle)"
  fi
done

mkdir -p "$OUT/$ERA" || exit 2
cp "$USERDATA/orca-data.json" "$OUT/$ERA/orca-data.json"

# The recorded command keeps the caller's arguments but never a host path.
CMD_ARGS=$(printf '%s' "$GENERATOR_ARGS" | sed -E "s# --work [^ ]+# --work <work>#")
case "$OUT" in /*) CMD_ARGS=$(printf '%s' "$CMD_ARGS" | sed -E "s# --out [^ ]+# --out <out>#") ;; esac

ERA="$ERA" FULL_SHA="$FULL_SHA" FLOOR="$FLOOR" REPO="$REPO" WRITER_DIR="$WRITER_DIR" OUTDIR="$OUT/$ERA" \
  USERDATA="$USERDATA" ERA_LOCK="$ERA_LOCK" CUR_LOCK="$CUR_LOCK" \
  CMD="bash config/scripts/persisted-session-corpus-generate.sh $CMD_ARGS" \
  node -e '
const fs = require("fs");
const cp = require("child_process");
const crypto = require("crypto");
const e = process.env;
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const git = (...a) => cp.execFileSync("git", ["-C", e.REPO, ...a], { encoding: "utf8" }).trim();
const result = JSON.parse(fs.readFileSync(e.USERDATA + "/expected.json", "utf8"));
const x = result.expected;
const tabCounts = Object.values(x.terminalTabsByWorktree).map((t) => t.length);
const tabs = tabCounts.reduce((a, b) => a + b, 0);
const worktreesWithTabs = tabCounts.filter((n) => n > 0).length;
const maxLeaves = Math.max(0, ...Object.values(x.splitLeavesByTab));
const holds = tabs >= 3 && worktreesWithTabs >= 2 && maxLeaves >= 2;
const data = e.OUTDIR + "/orca-data.json";
const provenance = {
  schemaVersion: 1,
  era: e.ERA,
  sourceSha: e.FULL_SHA,
  sourceDate: git("log", "-1", "--format=%cs", e.FULL_SHA),
  sourceSubject: git("log", "-1", "--format=%s", e.FULL_SHA),
  generatorCommand: e.CMD,
  writerSha256: sha(e.WRITER_DIR + "/era-session-writer.ts"),
  eraConfigSha256: sha(e.WRITER_DIR + "/era-vitest.config.mjs"),
  nodeVersion: process.version,
  eraLockfileSha256Prefix: e.ERA_LOCK,
  currentLockfileSha256Prefix: e.CUR_LOCK,
  eraSelfRead: result.eraSelfRead,
  outputSha256: sha(data),
  outputBytes: fs.statSync(data).size,
  expected: x,
  invariantsExercised: result.invariantsExercised,
  countsTowardFloor: e.FLOOR === "yes" && holds,
  clock: result.clock,
  ...(result.expectedSessionState ? { expectedSessionState: result.expectedSessionState } : {}),
};
fs.writeFileSync(e.OUTDIR + "/provenance.json", JSON.stringify(provenance, null, 2) + "\n");
console.log(
  "ERA_RESULT " + e.ERA + " sha=" + e.FULL_SHA.slice(0, 9) + " bytes=" + provenance.outputBytes +
  " sha256=" + provenance.outputSha256 + " self_read=" + provenance.eraSelfRead +
  " floor=" + (provenance.countsTowardFloor ? "yes" : "no") +
  " invariants=" + provenance.invariantsExercised.join(",")
);
' || drop "provenance emit failed"
