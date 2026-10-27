#!/usr/bin/env bash
# Disposable GEX44 build of out/ (phase 19). Fed on stdin: `ssh gex44 bash -s -- <mode> <root> < this-file`.
#   build    <root>: clone HEAD from <root>/p19.bundle, install, rebuild node-pty, build:electron-vite,
#                    tar out/ to <root>/out.tgz and print its sha256. Any failure removes the root.
#   teardown <root>: kill anything under <root>, remove it, print TEARDOWN and the NONE_P19 proof.
set -euo pipefail

MODE="${1:-}"
ROOT="${2:-}"
case "$ROOT" in
  /tmp/orca-phone-p19-*) ;;
  *)
    echo "REFUSE: root '$ROOT' is not under /tmp/orca-phone-p19-* (inside /tmp/orca-phone-p*)" >&2
    exit 2
    ;;
esac
case "$ROOT" in
  *..* | *' '* | */)
    echo "REFUSE: root '$ROOT' contains '..', a space or a trailing slash" >&2
    exit 2
    ;;
esac

remove_root() {
  set +e
  cd /
  # Match "$ROOT/repo" so no unrelated process (or this shell) is matched.
  pkill -f "$ROOT/repo" || true
  sleep 1
  pkill -9 -f "$ROOT/repo" || true
  local procs
  procs="$(pgrep -fc "$ROOT/repo" || true)"
  procs="${procs:-0}"
  rm -rf -- "$ROOT"
  if [ -e "$ROOT" ]; then
    echo "TEARDOWN procs=$procs root=present"
    return 3
  fi
  echo "TEARDOWN procs=$procs root=absent"
  echo "PROOF $(ls /tmp | grep orca-phone-p19 || echo NONE_P19)"
  return 0
}

case "$MODE" in
  teardown)
    remove_root
    exit $?
    ;;
  build) ;;
  *)
    echo "REFUSE: mode '$MODE' is not build|teardown" >&2
    exit 2
    ;;
esac

on_exit() {
  local rc="$1"
  if [ "$rc" -ne 0 ]; then
    echo "BUILD_FAIL rc=$rc"
    remove_root || true
  fi
  exit "$rc"
}
trap 'on_exit $?' EXIT

# shellcheck disable=SC1090
source ~/orca-env/env.sh
echo "RUNNER root=$ROOT host=$(hostname) node=$(node --version) pnpm=$(pnpm --version)"

REPO="$ROOT/repo"
git init -q "$REPO"
git -C "$REPO" fetch -q "$ROOT/p19.bundle" HEAD
git -C "$REPO" checkout -q --detach FETCH_HEAD
echo "RUNNER head=$(git -C "$REPO" rev-parse HEAD)"

cd "$REPO"
if ! timeout 900 pnpm install --frozen-lockfile --ignore-scripts > "$ROOT/install.log" 2>&1; then
  tail -40 "$ROOT/install.log"
  echo "RUNNER install=failed"
  exit 1
fi
echo "RUNNER install=ok"
if ! timeout 600 pnpm rebuild node-pty > "$ROOT/rebuild.log" 2>&1; then
  tail -40 "$ROOT/rebuild.log"
  echo "RUNNER rebuild_node_pty=failed"
  exit 1
fi
echo "RUNNER rebuild_node_pty=ok"
if ! timeout 1200 pnpm run build:electron-vite > "$ROOT/build.log" 2>&1; then
  tail -60 "$ROOT/build.log"
  echo "RUNNER build=failed"
  exit 1
fi
echo "RUNNER build=ok"
tar -czf "$ROOT/out.tgz" out
echo "RUNNER out_entries=$(tar -tzf "$ROOT/out.tgz" | wc -l)"
echo "SHA256_REMOTE $(sha256sum "$ROOT/out.tgz" | cut -d' ' -f1)"
