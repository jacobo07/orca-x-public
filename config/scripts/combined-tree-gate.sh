#!/usr/bin/env bash
# Combined-tree gate: builds this tree, runs the spine specs, unit groups and static gates listed in
# config/combined-tree-gate.jsonc, and judges the run by name and count. Every summary line except
# the header is minted, and the verdict computed, by combined-tree-gate-contract.mjs; this script
# only orchestrates and appends node's output.
#
# Linux test plane only (GEX44); run and dry-run refuse elsewhere. Runs IN PLACE in the tree that
# holds this script. HEAD and tracked dirt are re-asserted (TREE_AT lines) after the build, every
# spec, the unit groups and the gates, and again at the end; the verdict needs every one clean.
#
# Usage:
#   combined-tree-gate.sh --label <label> --expect <sha-prefix> [--manifest <path>]           real run
#   combined-tree-gate.sh --label <label> --expect <sha-prefix> [--manifest <path>] --dry-run  plan only
#   combined-tree-gate.sh --verdict-only <summary.txt> --manifest <run dir>/manifest.jsonc      re-judge
# The manifest is snapshotted into the run dir and used from the copy; the verdict names its hash
# (GREEN head=<sha> manifest=<sha16> committed=<0|1>) and fails when the summary names another.
# Run and dry-run share one preflight, so a dry-run is never laxer than a run. A dry-run prints
# DRY_RUN, the plan and WOULD_WRITE <dir>; it never builds or starts Electron.
#
# Env contract (no host path is written in this file; unset required values refuse, never default):
#   CTG_RUNS_DIR        required; existing directory that receives <label>-<sha9>/ (never reused).
#   CTG_TOOLCHAIN_BIN   optional; prepended to PATH. `node` must then match package.json engines.node.
#   CTG_LOCK_OWNER      optional; directory whose pnpm-lock.yaml must also match this tree's. Default: the
#                       parent of a node_modules that links to another checkout. The installed lock
#                       (node_modules/.pnpm/lock.yaml) is always compared when present; with neither
#                       comparison available the run refuses.
#   plus every requiredEnv of the manifest (MISSION_BRIEF_REPOS: colon-separated existing dirs).
#
# Worked GEX44 invocation:
#   CTG_RUNS_DIR=$HOME/closure-runs CTG_TOOLCHAIN_BIN=$HOME/.orca-toolchain/node24/bin \
#   MISSION_BRIEF_REPOS=$HOME/mb-fixtures/gsd-long-smoke:$HOME/mb-fixtures/wt-exec:$HOME/mb-fixtures/cognitive-resource-os \
#   config/scripts/combined-tree-gate.sh --label p2-tip --expect "$(git rev-parse --short=9 HEAD)"
#
# Exit: 0 GREEN (dry-run: planned), 1 RED, 2 NO_VERDICT or usage, 90 tree, 91 HEAD mismatch,
#       92 dirty, 93 run dir exists, 94 lock, 95 busy, 96 env/toolchain/platform, 97 manifest,
#       99 HEAD moved during the run.
set -u

TREE=$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null) || {
  echo "REFUSED_TREE $(dirname "$0") is not inside a git work tree"
  exit 90
}
CONTRACT=$TREE/config/scripts/combined-tree-gate-contract.mjs
MANIFEST=$TREE/config/combined-tree-gate.jsonc
[ -n "${CTG_TOOLCHAIN_BIN:-}" ] && export PATH="$CTG_TOOLCHAIN_BIN:$PATH"

refuse() {
  local code=$1
  shift
  echo "$*"
  exit "$code"
}

# ctg_verdict <summary>: prints the contract's verdict; returns 0/1/2.
# Why the line check: an entry guard that never fires exits 0 having printed nothing.
ctg_verdict() {
  local out rc n last
  out=$(node "$CONTRACT" verdict --manifest "$MANIFEST" --summary "$1" 2>&1)
  rc=$?
  printf '%s\n' "$out"
  n=$(printf '%s\n' "$out" | grep -c '^TIP_VERDICT ')
  last=$(printf '%s\n' "$out" | tail -n 1)
  if [ "$n" != 1 ]; then
    echo "TIP_VERDICT NO_VERDICT contract printed $n verdict lines"
    return 2
  fi
  case "$rc:$last" in
    "0:TIP_VERDICT GREEN "* | "1:TIP_VERDICT RED "* | "2:TIP_VERDICT NO_VERDICT "*) return "$rc" ;;
  esac
  echo "TIP_VERDICT NO_VERDICT contract exit=$rc disagrees with its last line"
  return 2
}

# tree_dirt: count of tracked changes, or `unknown` when git fails (never 0 on failure).
tree_dirt() {
  local out
  out=$(git status --porcelain --untracked-files=no) || {
    echo unknown
    return 0
  }
  printf '%s' "$out" | grep -c . || true
}

MODE=run
SUMMARY=
LABEL=
EXPECT=
while [ $# -gt 0 ]; do
  case "$1" in
    --verdict-only) MODE=verdict-only SUMMARY=${2:-} ;;
    --manifest) MANIFEST=${2:-} ;;
    --label) LABEL=${2:-} ;;
    --expect) EXPECT=${2:-} ;;
    --dry-run) MODE=dry-run ;;
    *) refuse 2 "REFUSED_USAGE unknown argument: $1" ;;
  esac
  case "$1" in --dry-run) shift ;; *) shift 2 || shift ;; esac
done
case "$MANIFEST" in /*) ;; *) MANIFEST=$PWD/$MANIFEST ;; esac

if [ "$MODE" = verdict-only ]; then
  [ -n "$SUMMARY" ] || refuse 2 "TIP_VERDICT NO_VERDICT --verdict-only needs a summary path"
  ctg_verdict "$SUMMARY"
  exit $?
fi
[[ "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]] || refuse 2 "REFUSED_USAGE --label <[A-Za-z0-9._-]+> is required"
[[ "$EXPECT" =~ ^[0-9a-f]{7,40}$ ]] || refuse 2 "REFUSED_USAGE --expect <7-40 hex sha prefix> is required"
cd "$TREE" || exit 90

# Why a snapshot: the plan, every unit result and the verdict read the manifest; a file edited mid-run
# (or kept outside the tree) must not change which contract judges this run. Copied into $RUN below.
MANIFEST_SRC=$MANIFEST
SNAP=$(mktemp) || refuse 97 "REFUSED_MANIFEST cannot create a manifest snapshot"
trap 'rm -f "$SNAP"' EXIT
cp "$MANIFEST_SRC" "$SNAP" 2> /dev/null || refuse 97 "REFUSED_MANIFEST cannot read $MANIFEST_SRC"
MANIFEST=$SNAP

SPECS=()
UNITS=()
GATES=()
PLAN=()
BASE=

# preflight: the ten refusals, in order; each check reached only by its own cause.
preflight() {
  [ "$(uname -s)" = Linux ] || refuse 96 "REFUSED_PLATFORM $(uname -s): the combined-tree gate runs on the Linux test plane only"

  local want have
  want=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).engines?.node ?? ""))' \
    "$TREE/package.json" 2>/dev/null)
  have=$(node --version 2>/dev/null | sed -E 's/^v([0-9]+)\..*/\1/')
  [[ "$want" =~ ^[0-9]+$ ]] || refuse 96 "REFUSED_TOOLCHAIN package.json engines.node '$want' is not a bare major (node $(node --version 2>&1))"
  [ "$have" = "$want" ] || refuse 96 "REFUSED_TOOLCHAIN node major '$have' at $(command -v node) != engines.node $want"

  local text rc line counts=
  local -a t
  text=$(node "$CONTRACT" plan --manifest "$MANIFEST" 2>&1)
  rc=$?
  [ "$rc" = 0 ] || refuse 97 "REFUSED_MANIFEST $MANIFEST_SRC: $text"
  mapfile -t PLAN <<< "$text"
  for line in "${PLAN[@]}"; do
    read -r -a t <<< "$line"
    case "${t[0]}" in
      PLAN_BASE) BASE=${t[1]} ;;
      PLAN_ENV | PLAN_REQUIRE_ENV) ;;
      PLAN_SPEC) SPECS+=("${t[1]}") ;;
      PLAN_UNIT) UNITS+=("$line") ;;
      PLAN_GATE) GATES+=("$line") ;;
      PLAN_COUNTS) counts=$line ;;
      *) refuse 97 "REFUSED_MANIFEST unexpected plan line: $line" ;;
    esac
  done
  [ "$counts" = "PLAN_COUNTS specs=${#SPECS[@]} units=${#UNITS[@]} gates=${#GATES[@]}" ] ||
    refuse 97 "REFUSED_MANIFEST plan counts '$counts' disagree with its lines"
  local spec
  for spec in "${SPECS[@]}"; do
    [ -f "tests/e2e/$spec.spec.ts" ] || refuse 97 "REFUSED_MANIFEST spec $spec has no tests/e2e/$spec.spec.ts"
  done

  [ -n "${CTG_RUNS_DIR:-}" ] || refuse 96 "REFUSED missing env CTG_RUNS_DIR"
  [ -d "$CTG_RUNS_DIR" ] || refuse 96 "REFUSED env CTG_RUNS_DIR=$CTG_RUNS_DIR is not a directory"

  local name value entry
  local -a parts
  for line in "${PLAN[@]}"; do
    read -r -a t <<< "$line"
    [ "${t[0]}" = PLAN_REQUIRE_ENV ] || continue
    name=${t[1]}
    value=${!name:-}
    [ -n "$value" ] || refuse 96 "REFUSED missing env $name (the manifest requires it)"
    [ "${t[2]}" = 1 ] || continue
    case "$value" in :* | *: | *::*) refuse 96 "REFUSED env $name has an empty entry" ;; esac
    IFS=: read -r -a parts <<< "$value"
    for entry in "${parts[@]}"; do
      [ -d "$entry" ] || refuse 96 "REFUSED env $name entry '$entry' is not an existing directory"
    done
  done

  HEAD=$(git rev-parse HEAD)
  case "$HEAD" in "$EXPECT"*) ;; *) refuse 91 "REFUSED_HEAD_MISMATCH expected=$EXPECT head=$HEAD" ;; esac
  DIRTY=$(tree_dirt)
  [ "$DIRTY" = 0 ] || refuse 92 "REFUSED_DIRTY_TREE dirty=$DIRTY"
  git rev-parse --verify --quiet "$BASE^{commit}" > /dev/null || refuse 97 "REFUSED_MANIFEST base $BASE is not a commit here"

  local owner here there installed=node_modules/.pnpm/lock.yaml compared=0
  [ -e node_modules ] || refuse 94 "REFUSED_LOCK no node_modules in $TREE"
  [ -f pnpm-lock.yaml ] || refuse 94 "REFUSED_LOCK no pnpm-lock.yaml in $TREE"
  here=$(sha256sum pnpm-lock.yaml | cut -c1-16)
  # Why the installed lock: pnpm records the lock it installed from; a checkout file only says what was
  # intended, and a local node_modules makes the tree's own lockfile compare equal to itself.
  if [ -f "$installed" ]; then
    there=$(sha256sum "$installed" | cut -c1-16)
    [ "$here" = "$there" ] || refuse 94 "LOCK_MISMATCH here=$here node_modules_installed=$there ($installed)"
    compared=1
  fi
  owner=${CTG_LOCK_OWNER:-}
  if [ -z "$owner" ]; then
    owner=$(dirname "$(readlink -f node_modules)") || refuse 94 "REFUSED_LOCK cannot resolve node_modules"
    [ "$owner" = "$TREE" ] && owner=
  fi
  if [ -n "$owner" ]; then
    [ -f "$owner/pnpm-lock.yaml" ] || refuse 94 "REFUSED_LOCK no pnpm-lock.yaml in lock owner $owner"
    there=$(sha256sum "$owner/pnpm-lock.yaml" | cut -c1-16)
    [ "$here" = "$there" ] || refuse 94 "LOCK_MISMATCH here=$here node_modules_owner=$there ($owner)"
    compared=1
  fi
  [ "$compared" = 1 ] ||
    refuse 94 "REFUSED_LOCK no meaningful comparison: no $installed and node_modules is not a link to another checkout (set CTG_LOCK_OWNER)"
  LOCK=$here

  RUN=$CTG_RUNS_DIR/$LABEL-${HEAD:0:9}
  [ ! -e "$RUN" ] || refuse 93 "REFUSED_RUN_DIR_EXISTS $RUN (evidence is never overwritten or appended)"
}

preflight
if [ "$MODE" = dry-run ]; then
  echo DRY_RUN
  printf '%s\n' "${PLAN[@]}"
  echo "WOULD_WRITE $RUN"
  exit 0
fi

mkdir "$RUN" || refuse 93 "REFUSED_RUN_DIR_EXISTS $RUN"
cp "$SNAP" "$RUN/manifest.jsonc" || refuse 97 "REFUSED_MANIFEST cannot snapshot $MANIFEST_SRC into $RUN"
rm -f "$SNAP"
MANIFEST=$RUN/manifest.jsonc
# committed=1: the snapshot is byte-identical to the manifest committed at HEAD.
committed=0
git show "HEAD:config/combined-tree-gate.jsonc" > "$RUN/manifest-at-head.jsonc" 2> /dev/null &&
  cmp -s "$RUN/manifest-at-head.jsonc" "$MANIFEST" && committed=1
rm -f "$RUN/manifest-at-head.jsonc"
S=$RUN/summary.txt
RUN_ID=$LABEL-${HEAD:0:9}-$$
log_line() { printf '%s\n' "$*" | tee -a "$S"; }
# append <cmd...>: node mints the line; bash only appends it.
append() { "$@" 2>&1 | tee -a "$S"; }

# Foreign `playwright test` processes: neither cmdline nor cwd in this tree. `[p]` keeps the pattern
# from matching any shell whose own cmdline carries the literal pattern.
foreign_playwright() {
  local pid cwd cmd
  for pid in $(pgrep -f '[p]laywright(/cli\.js)? test'); do
    [ "$pid" = "$$" ] && continue
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null) || continue
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null)
    case "$cmd" in *"$TREE"*) continue ;; esac
    [ "$cwd" = "$TREE" ] && continue
    echo "$pid $cmd"
  done
}

# assert_tree <phase>: mints TREE_AT; fails when HEAD is not the start HEAD or the tree is dirty.
assert_tree() {
  local h d
  h=$(git rev-parse HEAD) || h=unknown
  d=$(tree_dirt)
  log_line "TREE_AT $1 head=$h dirty=$d"
  [ "$h" = "$HEAD" ] && [ "$d" = 0 ]
}

# reap_run_processes: SIGKILL every process this run's specs started, found by the CTG_RUN_ID they
# inherited. Never by path: a developer's Orca (or its PTY daemon) from this tree carries no marker.
reap_run_processes() {
  local dir pid
  for dir in /proc/[0-9]*; do
    pid=${dir#/proc/}
    [ "$pid" = "$$" ] && continue
    grep -qFazx "CTG_RUN_ID=$RUN_ID" "$dir/environ" 2> /dev/null && kill -KILL "$pid" 2> /dev/null
  done
  return 0
}

# finish <code>: append the verdict and CTG_END; exit <code>, or the verdict's code when <code> is 0.
finish() {
  local out verdict_rc code=$1
  reap_run_processes
  out=$(ctg_verdict "$S")
  verdict_rc=$?
  printf '%s\n' "$out" | tee -a "$S"
  log_line "CTG_END $LABEL $(date -u +%FT%TZ)"
  [ "$code" = 0 ] && code=$verdict_rc
  exit "$code"
}

log_line "CTG_START $LABEL $(date -u +%FT%TZ)"
log_line "HEAD=$HEAD dirty=$(tree_dirt)"
log_line "LOCK_OK $LOCK"
log_line "CTG_MANIFEST sha256=$(sha256sum "$MANIFEST" | cut -c1-16) committed=$committed $MANIFEST"
log_line "MEM_AVAILABLE_GB=$(free -g | awk '/^Mem:/ {print $7}')"
waited=0
while busy=$(foreign_playwright) && [ -n "$busy" ]; do
  if [ "$waited" -ge 1800 ]; then
    log_line "RESOURCE_BUSY after ${waited}s: $(echo "$busy" | head -1 | cut -c1-200)"
    exit 95
  fi
  log_line "WAIT_FOREIGN_PLAYWRIGHT waited=${waited}s $(echo "$busy" | head -1 | cut -c1-160)"
  sleep 60
  waited=$((waited + 60))
done
log_line PREFLIGHT_OK

build_log=$RUN/build-real.log
VITE_EXPOSE_STORE=true timeout 1500 node_modules/.bin/electron-vite build --mode e2e > "$build_log" 2>&1
rc=$?
[ "$rc" = 0 ] && { timeout 600 node config/scripts/build-relay.mjs >> "$build_log" 2>&1 || rc=$?; }
[ "$rc" = 0 ] && {
  timeout 900 node node_modules/typescript/bin/tsc -p config/tsconfig.cli.json --outDir out --composite false \
    --incremental false >> "$build_log" 2>&1 || rc=$?
}
built_head=$(git rev-parse HEAD) || built_head=unknown
log_line "BUILD_real_EXIT=$rc head=${built_head:0:9} dirty=$(tree_dirt)"
[ "$rc" = 0 ] || finish 0

# Why not export: specEnv belongs to the specs, so it is passed to them with `env` and never lands in
# this script's scope, where it could shadow a variable the judging code reads.
spec_env=()
for line in "${PLAN[@]}"; do
  read -r -a t <<< "$line"
  [ "${t[0]}" = PLAN_ENV ] && spec_env+=("${t[1]}=${t[2]}")
done

moved=0
assert_tree build || moved=1
for spec in "${SPECS[@]}"; do
  if [ "$moved" = 1 ]; then
    append node "$CONTRACT" spec-result --name "$spec" --exit 99 --head-moved "${HEAD:0:9}"
    continue
  fi
  log=$RUN/spec-$spec-real.log
  env "CTG_RUN_ID=$RUN_ID" "${spec_env[@]}" SKIP_BUILD=1 timeout 1500 xvfb-run -a -s "-screen 0 2560x1600x24" node_modules/.bin/playwright test \
    --config tests/playwright.config.ts --project=electron-headless --project=electron-headful --workers=1 \
    --reporter=list --output "$RUN/results/$spec-real" "tests/e2e/$spec.spec.ts" > "$log" 2>&1
  rc=$?
  append node "$CONTRACT" spec-result --name "$spec" --exit "$rc" --log "$log"
  reap_run_processes
  sleep 2
  assert_tree "spec-$spec" || moved=1
done
# Why stop here: units and gates of a tree that moved under the run describe no single revision.
[ "$moved" = 1 ] && finish 99

for line in "${UNITS[@]}"; do
  read -r -a t <<< "$line"
  group=${t[1]}
  timeout 900 node_modules/.bin/vitest run --config config/vitest.config.ts "${t[@]:4}" --reporter=default \
    --reporter=json "--outputFile.json=$RUN/unit-$group.json" > "$RUN/unit-$group.log" 2>&1
  rc=$?
  append node "$CONTRACT" unit-result --manifest "$MANIFEST" --group "$group" --exit "$rc" \
    --log "$RUN/unit-$group.log" --json "$RUN/unit-$group.json" --failures-out "$RUN/unit-$group-failures.txt"
done
assert_tree units || finish 99

mapfile -t CHANGED < <(git diff --name-only --diff-filter=AM "$BASE..HEAD" -- '*.ts' '*.tsx' '*.mjs')
printf '%s\n' "${CHANGED[@]}" > "$RUN/changed-files.txt"
log_line "CHANGED_FILES ${#CHANGED[@]} since $BASE ($RUN/changed-files.txt)"

for line in "${GATES[@]}"; do
  read -r -a t <<< "$line"
  name=${t[1]}
  argv=("${t[@]:3}")
  if [ "${t[2]}" = 1 ]; then
    if [ "${#CHANGED[@]}" = 0 ]; then
      append node "$CONTRACT" gate-result --name "$name" --no-changed-files
      continue
    fi
    argv+=("${CHANGED[@]}")
  fi
  timeout 900 "${argv[@]}" > "$RUN/gate-$name.log" 2>&1
  rc=$?
  append node "$CONTRACT" gate-result --name "$name" --exit "$rc" --log "$RUN/gate-$name.log"
done
assert_tree gates || finish 99
assert_tree end || finish 99

finish 0
