#!/usr/bin/env bash
# AEOS remote suite runner for a verification host (GEX44).
#
# Why this exists: on 2026-09-22 a remote full suite wrote to a fixed path
# (~/vitest-clean.log), died 4m36s in, and left no exit code and no summary.
# The log could not say whether the run passed, failed, or was killed -- and
# starting it had already overwritten the previous run's evidence. A run that
# cannot state its own verdict produced no evidence at all.
#
# Every run gets its own directory. The exit code is written by a trap, so its
# ABSENCE is itself a verdict (the process group was terminated). The machine
# verdict comes from rc + the JSON reporter; the dot log is diagnostics only.
#
#   aeos-remote-suite-run.sh [--detach]
#
# Env: AEOS_REPO AEOS_RUNS_ROOT AEOS_TOOLCHAIN_BIN AEOS_BUDGET_SECONDS
#      AEOS_VITEST_ARGS (scope a short proving run instead of the full suite)
set -u

REPO="${AEOS_REPO:-$HOME/orca-x}"
RUNS_ROOT="${AEOS_RUNS_ROOT:-$HOME/aeos-runs}"
TOOLCHAIN_BIN="${AEOS_TOOLCHAIN_BIN:-$HOME/.orca-toolchain/node24/bin}"
BUDGET_SECONDS="${AEOS_BUDGET_SECONDS:-5400}"

export PATH="$TOOLCHAIN_BIN:$PATH"
cd "$REPO" || { echo "AEOS: repo not found: $REPO" >&2; exit 90; }

SHA="$(git rev-parse HEAD 2>/dev/null)" || { echo "AEOS: not a git repo: $REPO" >&2; exit 91; }
SHORT="$(printf '%.7s' "$SHA")"

if [ -n "${AEOS_RUN_DIR:-}" ]; then
  RUN_DIR="$AEOS_RUN_DIR"
else
  RUN_DIR="$RUNS_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$SHORT"
fi
mkdir -p "$RUN_DIR" || exit 92

# Re-exec under setsid so the run outlives the SSH carrier that started it.
# Detachment is part of this artifact, not a remembered invocation.
if [ "${1:-}" = "--detach" ]; then
  AEOS_RUN_DIR="$RUN_DIR" setsid nohup "$0" >"$RUN_DIR/launcher.log" 2>&1 &
  echo "RUN_DIR=$RUN_DIR"
  echo "LAUNCHER_PID=$!"
  exit 0
fi

mem_available_mb() { awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo; }
load1() { cut -d' ' -f1 /proc/loadavg; }

# Start facts are immutable once written; end facts land in a second file so a
# SIGKILL mid-run cannot truncate the binding that makes this run attributable.
cat > "$RUN_DIR/run.json" <<JSON
{
  "schema": "aeos-remote-run/1",
  "sha": "$SHA",
  "host": "$(hostname)",
  "user": "$(id -un)",
  "toolchain": {
    "node": "$(node --version 2>/dev/null || echo absent)",
    "nodePath": "$(command -v node || echo absent)",
    "systemNode": "$(/usr/bin/node --version 2>/dev/null || echo absent)",
    "vitest": "$(node -p "require('./node_modules/vitest/package.json').version" 2>/dev/null || echo absent)"
  },
  "startedAt": "$(date -u +%FT%TZ)",
  "vitestArgs": "${AEOS_VITEST_ARGS:-}",
  "pid": $$,
  "pgid": $(ps -o pgid= -p $$ | tr -d ' '),
  "ppid": $PPID,
  "budgetSeconds": $BUDGET_SECONDS,
  "before": { "memAvailableMb": $(mem_available_mb), "load1": $(load1) }
}
JSON

SIGNAL=""
finish() {
  rc=$?
  cat > "$RUN_DIR/run-end.json" <<JSON
{
  "schema": "aeos-remote-run-end/1",
  "endedAt": "$(date -u +%FT%TZ)",
  "signal": "$SIGNAL",
  "after": { "memAvailableMb": $(mem_available_mb), "load1": $(load1) }
}
JSON
  # rc is written LAST: a reader that finds it knows every other artifact settled.
  printf '%s\n' "$rc" > "$RUN_DIR/rc"
}
on_signal() { SIGNAL="$1"; exit $((128 + $2)); }
trap 'on_signal HUP 1' HUP
trap 'on_signal INT 2' INT
trap 'on_signal TERM 15' TERM
trap finish EXIT

# shellcheck disable=SC2086
timeout --signal=TERM --kill-after=60 "$BUDGET_SECONDS" \
  node node_modules/vitest/vitest.mjs run \
    --config config/vitest.config.ts \
    --reporter=dot \
    --reporter=json \
    --outputFile.json="$RUN_DIR/vitest.json" \
    ${AEOS_VITEST_ARGS:-} \
  > "$RUN_DIR/vitest.log" 2>&1
