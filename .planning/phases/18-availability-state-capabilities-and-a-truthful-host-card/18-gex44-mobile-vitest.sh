#!/usr/bin/env bash
# Disposable GEX44 mobile runner: clone HEAD from a bundle, overlay synced files, run vitest (and in
# full mode oxlint, oxfmt --check and touched-file tsc), then always delete the root in the EXIT trap.
# Usage: bash run.sh /tmp/orca-phone-p18-<ts> test|full <files relative to mobile/...>
set -euo pipefail

ROOT="${1:-}"
MODE="${2:-}"
case "$ROOT" in
  /tmp/orca-phone-p18-*) ;;
  *)
    echo "REFUSE: root '$ROOT' is not under /tmp/orca-phone-p18-*" >&2
    exit 2
    ;;
esac
case "$ROOT" in
  *..* | *' '* | */)
    echo "REFUSE: root '$ROOT' contains '..', a space or a trailing slash" >&2
    exit 2
    ;;
esac
case "$MODE" in
  test | full) ;;
  *)
    echo "REFUSE: mode '$MODE' is not test|full" >&2
    exit 2
    ;;
esac
shift 2
if [ "$#" -eq 0 ]; then
  echo "REFUSE: no test files given" >&2
  exit 2
fi

teardown() {
  local rc="$1"
  set +e
  cd /
  # Match "$ROOT/repo" so this script's own argv (which names $ROOT/run.sh) never matches.
  pkill -f "$ROOT/repo" || true
  sleep 1
  pkill -9 -f "$ROOT/repo" || true
  local procs
  procs="$(pgrep -fc "$ROOT/repo" || true)"
  procs="${procs:-0}"
  rm -rf -- "$ROOT"
  if [ -e "$ROOT" ]; then
    echo "TEARDOWN procs=$procs root=present"
    exit 3
  fi
  echo "TEARDOWN procs=$procs root=absent"
  exit "$rc"
}
trap 'teardown $?' EXIT

# shellcheck disable=SC1090
source ~/orca-env/env.sh
echo "RUNNER root=$ROOT mode=$MODE host=$(hostname) node=$(node --version) pnpm=$(pnpm --version)"

REPO="$ROOT/repo"
git init -q "$REPO"
git -C "$REPO" fetch -q "$ROOT/p18.bundle" HEAD
git -C "$REPO" checkout -q --detach FETCH_HEAD
echo "RUNNER base=$(git -C "$REPO" rev-parse --short HEAD)"

SYNCED_MOBILE=()
if [ -f "$ROOT/p18.tar" ]; then
  tar -xf "$ROOT/p18.tar" -C "$REPO"
  while IFS= read -r entry; do
    if [ -f "$REPO/$entry" ]; then
      # The Windows checkout is CRLF (autocrlf); git commits LF, so match what is committed.
      sed -i 's/\r$//' "$REPO/$entry"
      case "$entry" in
        mobile/*) SYNCED_MOBILE+=("${entry#mobile/}") ;;
      esac
    fi
  done < <(tar -tf "$ROOT/p18.tar")
  echo "RUNNER synced=${#SYNCED_MOBILE[@]} mobile files: ${SYNCED_MOBILE[*]:-none}"
fi

cd "$REPO/mobile"
if ! pnpm install --frozen-lockfile --ignore-scripts > "$ROOT/install.log" 2>&1; then
  tail -40 "$ROOT/install.log"
  echo "RUNNER install=failed"
  exit 1
fi
echo "RUNNER install=ok"

FAIL=0
set +e
pnpm exec vitest run "$@"
VITEST_RC=$?
set -e
echo "RUNNER vitest_rc=$VITEST_RC"
[ "$VITEST_RC" -eq 0 ] || FAIL=1

if [ "$MODE" = "full" ]; then
  declare -A seen=()
  CHECK=()
  for f in "${SYNCED_MOBILE[@]}" "$@"; do
    if [ -z "${seen[$f]:-}" ] && [ -f "$f" ]; then
      seen[$f]=1
      CHECK+=("$f")
    fi
  done
  echo "RUNNER check files: ${CHECK[*]}"

  set +e
  pnpm exec oxlint "${CHECK[@]}"
  LINT_RC=$?
  pnpm exec oxfmt --check "${CHECK[@]}"
  FMT_RC=$?
  pnpm run typecheck > "$ROOT/tsc.log" 2>&1
  TSC_RC=$?
  set -e
  echo "RUNNER oxlint_rc=$LINT_RC oxfmt_rc=$FMT_RC tsc_rc=$TSC_RC"
  [ "$LINT_RC" -eq 0 ] || FAIL=1
  [ "$FMT_RC" -eq 0 ] || FAIL=1

  TOTAL_TSC="$(grep -c 'error TS' "$ROOT/tsc.log" || true)"
  grep 'error TS' "$ROOT/tsc.log" | head -20 | sed 's/^/TSC /' || true
  TOUCHED_TSC=0
  for f in "${CHECK[@]}"; do
    n="$(grep -F "$f(" "$ROOT/tsc.log" | grep -c 'error TS' || true)"
    if [ "${n:-0}" -gt 0 ]; then
      grep -F "$f(" "$ROOT/tsc.log" | grep 'error TS'
      TOUCHED_TSC=$((TOUCHED_TSC + n))
    fi
  done
  echo "RUNNER tsc_errors_total=${TOTAL_TSC:-0} tsc_errors_preexisting=$(( ${TOTAL_TSC:-0} - TOUCHED_TSC )) tsc_errors_touched=$TOUCHED_TSC"
  [ "$TOUCHED_TSC" -eq 0 ] || FAIL=1
fi

echo "RUNNER result=$([ "$FAIL" -eq 0 ] && echo PASS || echo FAIL)"
exit "$FAIL"
