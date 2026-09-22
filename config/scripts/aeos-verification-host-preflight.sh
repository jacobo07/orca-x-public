#!/usr/bin/env bash
# What a Linux host must already have before it can verify Orca -- declared, and checked.
#
#   aeos-verification-host-preflight.sh [--serve]
#
# Every row below was discovered by provisioning GEX44 on 2026-09-22, and most were discovered
# the expensive way: a failed install, a dead suite, an aborted server. Written here they fail
# in seconds on the next host instead. The declaration IS the check, so it cannot drift from it.
#
# Classes
#   REQUIRED   verification cannot run without it           -> MISSING, exit 1
#   SERVE      needed only to prove `orca serve` (--serve)   -> MISSING, exit 1 with --serve
#   OPTIONAL   a test surface; its absence reds named tests   -> ABSENT, never fatal
#   POSTURE    a deliberate stance, reported so it is chosen -> POSTURE, never fatal
#
# Env: AEOS_REPO (default ~/orca-x)  AEOS_TOOLCHAIN_BIN (default ~/.orca-toolchain/node24/bin)
set -u

REPO="${AEOS_REPO:-$HOME/orca-x}"
TOOLCHAIN_BIN="${AEOS_TOOLCHAIN_BIN:-$HOME/.orca-toolchain/node24/bin}"
WANT_SERVE=0
[ "${1:-}" = "--serve" ] && WANT_SERVE=1

missing=0
row() { printf '%-9s %-26s %-9s %s\n' "$1" "$2" "$3" "$4"; }
need() {
  # need <class> <id> <ok?> <why>
  local class="$1" id="$2" ok="$3" why="$4"
  if [ "$ok" = 1 ]; then row OK "$id" "$class" "$why"; return; fi
  case "$class" in
    REQUIRED) row MISSING "$id" "$class" "$why"; missing=$((missing + 1)) ;;
    SERVE)
      if [ "$WANT_SERVE" = 1 ]; then row MISSING "$id" "$class" "$why"; missing=$((missing + 1))
      else row ABSENT "$id" "$class" "$why (only needed with --serve)"; fi ;;
    OPTIONAL) row ABSENT "$id" "$class" "$why" ;;
  esac
}
has() { command -v "$1" >/dev/null 2>&1 && echo 1 || echo 0; }

echo "host=$(hostname) user=$(id -un) repo=$REPO"
row RESULT PREREQUISITE CLASS WHY

# System Node stays whatever the host has; Orca's is selected by PATH, never installed over it.
toolchain_node=0
if [ -x "$TOOLCHAIN_BIN/node" ] && "$TOOLCHAIN_BIN/node" --version 2>/dev/null | grep -q '^v24\.'; then toolchain_node=1; fi
need REQUIRED node-24-user-local "$toolchain_node" "Orca needs Node 24; system Node $(/usr/bin/node --version 2>/dev/null || echo absent) is left untouched"

pnpm_ok=0
if [ -f "$REPO/package.json" ] && [ -x "$TOOLCHAIN_BIN/pnpm" ]; then
  want=$(grep -o '"packageManager": *"pnpm@[0-9.]*' "$REPO/package.json" | grep -o '[0-9][0-9.]*$')
  have=$("$TOOLCHAIN_BIN/pnpm" --version 2>/dev/null)
  [ -n "$want" ] && [ "$want" = "$have" ] && pnpm_ok=1
fi
need REQUIRED pnpm-exact-pin "$pnpm_ok" "must equal package.json packageManager; a drifted pnpm resolves a different lockfile"

need REQUIRED git "$(has git)" "the run manifest binds every result to a revision"
need REQUIRED python3 "$(has python3)" "the reaper reads the run manifest to find the session it may signal"
# Hidden until 2026-09-22: Electron's postinstall shells out to `unzip`, and fails with a bare
# `spawnSync unzip ENOENT` that names neither Electron nor the fix.
need REQUIRED unzip "$(has unzip)" "Electron's postinstall extracts its binary with it"

repo_ok=0
[ -d "$REPO/.git" ] && [ -d "$REPO/node_modules/electron" ] && repo_ok=1
need REQUIRED repo-installed "$repo_ok" "clone plus node_modules, delivered as a git bundle over the existing SSH trust -- no new credential"

mem_mb=$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo)
mem_ok=0; [ "${mem_mb:-0}" -ge 8192 ] && mem_ok=1
need REQUIRED memory-headroom "$mem_ok" "${mem_mb} MB available now; the full suite at 12 workers needs >= 8192, and a failure below 2048 is not attributable"

need SERVE xvfb-run "$(has xvfb-run)" "headless Electron still needs a display; xvfb-run -a allocates a private one instead of borrowing another tenant's"

# Hidden until 2026-09-22: four capture-visual-producer tests fail with "could not launch chromium".
pw_ok=0
ls "$HOME"/.cache/ms-playwright/chromium* >/dev/null 2>&1 && pw_ok=1
need OPTIONAL playwright-chromium "$pw_ok" "without it capture-visual-producer reds 4 tests as host, not product"

# Postures: reported so they are chosen, never silently defaulted.
sandbox="$(ls -l "$REPO"/node_modules/.pnpm/electron@*/node_modules/electron/dist/chrome-sandbox 2>/dev/null | head -n 1)"
case "$sandbox" in
  -rwsr-xr-x*root*) row POSTURE chromium-sandbox POSTURE "chrome-sandbox is root 4755; serve can run sandboxed" ;;
  *) row POSTURE chromium-sandbox POSTURE "chrome-sandbox is not root 4755; serve runs --no-sandbox (ORCA_APPIMAGE_NO_SANDBOX=1). Fixing it is a root change the next install undoes" ;;
esac

fw="unknown"
if command -v ufw >/dev/null 2>&1; then fw=$(sudo -n ufw status 2>/dev/null | head -n 1 | awk '{print $2}'); fi
row POSTURE serve-exposure POSTURE "serve binds 0.0.0.0 with no bind-address option; ufw=${fw:-unreadable}. On a public host, firewall the port before a resident serve"

row POSTURE isolated-home POSTURE "serve writes hooks into the REAL ~/.codex and ~/.claude (codex-real-home-hook-install.ts). XDG_CONFIG_HOME does not contain it; a resident serve on a shared host runs under its own HOME"

echo "missing=$missing"
[ "$missing" -eq 0 ]
