#!/usr/bin/env bash
# GEX44 provisioning for the DWS-P2 tracer: a fenced build of this branch, installed under a
# dedicated `orca-svc` service account, run under systemd bound to loopback only (CTX-EXP-1,
# CTX-SVC-1/2/3). Invoked over ssh as a single quoted argument (see STATE.md's PowerShell->ssh
# quoting traps) -- never edited from a PowerShell-built heredoc.
#
#   dws-gex44-serve-provision.sh fetch-bundle <bundle-remote-path> <sha> <short>
#   dws-gex44-serve-provision.sh build <sha>
#   dws-gex44-serve-provision.sh install <sha> <artifact-path> <artifact-sha256>
#   dws-gex44-serve-provision.sh ready-json
#   dws-gex44-serve-provision.sh status
#   dws-gex44-serve-provision.sh ps-capture <count> <interval-seconds>
set -u

CLONE_DIR="${DWS_CLONE_DIR:-$HOME/dws-0104-clone}"
RUNS_DIR="${DWS_RUNS_DIR:-$HOME/dws-runs}"
SVC_USER="orca-svc"
SVC_HOME="/home/$SVC_USER"
SVC_ROOT="$SVC_HOME/.orca-dws"
SVC_CHECKOUT_ROOT="$SVC_HOME/dws-p2"
SERVE_PORT=6791
UNIT_NAME="orca-dws-serve.service"
NODE24_BIN="/home/kobii/.orca-toolchain/node24/bin"

cmd="${1:-}"
shift || true

# --- fetch-bundle -------------------------------------------------------------
# Multi-step remote git logic runs here (never as a PowerShell-built ssh body,
# per STATE.md's quoting traps -- no ${VAR%...}/${VAR#...} or `rm` in that body).
cmd_fetch_bundle() {
  local bundle="${1:-}" sha="${2:-}" short="${3:-}"
  [ -n "$bundle" ] && [ -n "$sha" ] && [ -n "$short" ] || {
    echo "usage: fetch-bundle <bundle-remote-path> <sha> <short>" >&2; exit 2
  }
  local before_head
  before_head=$(git -C /home/kobii/orca-x rev-parse HEAD)
  echo "ORCA_X_HEAD_BEFORE=$before_head"

  git -C /home/kobii/orca-x fetch "$bundle" "HEAD:refs/heads/dws-p2-$short"
  echo "FETCH_INTO_ORCA_X_OK dws-p2-$short"

  local clone_before_head
  clone_before_head=$(git -C "$CLONE_DIR" rev-parse HEAD 2>/dev/null || echo none)
  echo "CLONE_HEAD_BEFORE=$clone_before_head"

  git -C "$CLONE_DIR" fetch /home/kobii/orca-x "refs/heads/dws-p2-$short:refs/heads/dws-p2-$short"
  git -C "$CLONE_DIR" checkout --detach "$sha"

  local clone_head
  clone_head=$(git -C "$CLONE_DIR" rev-parse HEAD)
  if [ "$clone_head" = "$sha" ]; then
    echo "FENCE_OK $sha"
  else
    echo "FENCE_MISMATCH expected=$sha actual=$clone_head"
    exit 3
  fi

  local after_head
  after_head=$(git -C /home/kobii/orca-x rev-parse HEAD)
  echo "ORCA_X_HEAD_AFTER=$after_head"
  if [ "$after_head" != "$before_head" ]; then
    echo "ORCA_X_HEAD_MOVED before=$before_head after=$after_head"
    exit 4
  fi
}

# --- build ------------------------------------------------------------------
cmd_build() {
  local sha="${1:-}"
  [ -n "$sha" ] || { echo "usage: build <sha>" >&2; exit 2; }

  local actual
  actual=$(git -C "$CLONE_DIR" rev-parse HEAD)
  if [ "$actual" != "$sha" ]; then
    echo "FENCE_MISMATCH expected=$sha actual=$actual"
    exit 3
  fi
  echo "FENCE_OK $sha"

  export PATH="$NODE24_BIN:$PATH"

  local free_before
  free_before=$(df --output=avail -BG / | tail -1 | tr -dc '0-9')
  echo "DISK_FREE_GB=${free_before} (before)"
  if [ "${free_before:-0}" -lt 20 ]; then
    echo "DISK_FLOOR_REFUSED free=${free_before}G floor=20G"
    exit 4
  fi

  local short="${sha:0:7}"
  local run_dir="$RUNS_DIR/p2-${short}-build"
  mkdir -p "$run_dir"

  run_step() {
    local name="$1"; shift
    ( cd "$CLONE_DIR" && "$@" ) >"$run_dir/$name.log" 2>&1
    local rc=$?
    echo "STEP $name rc=$rc"
    return $rc
  }

  run_step build-relay pnpm run build:relay || exit 5
  # Why not build:cli: that script's install-dev-cli step writes a CLI shim into kobii's environment.
  run_step build-cli node node_modules/typescript/bin/tsc -p config/tsconfig.cli.json --outDir out --composite false --incremental false || exit 5
  run_step build-electron-vite pnpm run build:electron-vite || exit 5
  run_step build-web pnpm run build:web-from-renderer || exit 5
  run_step typecheck-node node node_modules/typescript/bin/tsc --noEmit -p config/tsconfig.node.json || exit 5
  run_step typecheck-tc-cli node node_modules/typescript/bin/tsc --noEmit -p config/tsconfig.tc.cli.json || exit 5
  run_step typecheck-tc-web node node_modules/typescript/bin/tsc --noEmit -p config/tsconfig.tc.web.json || exit 5

  local dirty
  dirty=$(git -C "$CLONE_DIR" status --porcelain --untracked-files=no)
  if [ -n "$dirty" ]; then
    echo "TREE_CLEAN=0"
    echo "$dirty"
    exit 6
  fi
  echo "TREE_CLEAN=1"

  local artifact="$RUNS_DIR/p2-${short}-out.tar.gz"
  tar -czf "$artifact" -C "$CLONE_DIR" out
  local artifact_sha256
  artifact_sha256=$(sha256sum "$artifact" | awk '{print $1}')
  echo "ARTIFACT=$artifact ARTIFACT_SHA256=$artifact_sha256"

  local free_after
  free_after=$(df --output=avail -BG / | tail -1 | tr -dc '0-9')
  echo "DISK_FREE_GB=${free_after} (after)"
}

# --- install ------------------------------------------------------------------
need_row() {
  # need_row <class> <id> <ok 0|1> <why>
  printf '%-9s %-28s %-9s %s\n' "$([ "$3" = 1 ] && echo OK || echo MISSING)" "$2" "$1" "$4"
}

cmd_install() {
  local sha="${1:-}" artifact="${2:-}" expected_sha256="${3:-}"
  [ -n "$sha" ] && [ -n "$artifact" ] && [ -n "$expected_sha256" ] || {
    echo "usage: install <sha> <artifact-path> <artifact-sha256>" >&2; exit 2
  }
  if [ "$(id -u)" != 0 ]; then
    echo "REFUSED: install must run as root (sudo)" >&2
    exit 2
  fi
  if [ "${DWS_RUN_AS_ROOT:-}" = "1" ]; then
    echo "REFUSED: --run-as root is not a supported mode for the service identity" >&2
    exit 2
  fi

  echo "host=$(hostname) user=$(id -un)"
  echo "RESULT    PREREQUISITE                CLASS     WHY"

  local actual_sha256
  actual_sha256=$(sha256sum "$artifact" | awk '{print $1}')
  local sha_ok=0; [ "$actual_sha256" = "$expected_sha256" ] && sha_ok=1
  need_row REQUIRED artifact-sha256-match "$sha_ok" "the artifact that runs must be the one the build produced"

  local disk_free
  disk_free=$(df --output=avail -BG / | tail -1 | tr -dc '0-9')
  local disk_ok=0; [ "${disk_free:-0}" -ge 20 ] && disk_ok=1
  need_row REQUIRED disk-floor-20G "$disk_ok" "${disk_free}G free"

  local xvfb_ok=0; command -v xvfb-run >/dev/null 2>&1 && xvfb_ok=1
  need_row REQUIRED xvfb-run "$xvfb_ok" "headless Electron needs a display"

  local node24_ok=0; [ -x "$NODE24_BIN/node" ] && node24_ok=1
  need_row REQUIRED node24-dir "$node24_ok" "$NODE24_BIN"

  local electron_bin="/home/kobii/orca-x/node_modules/electron/dist/electron"
  local electron_ok=0; [ -x "$electron_bin" ] && electron_ok=1
  need_row REQUIRED electron-binary "$electron_ok" "$electron_bin"

  local port_ok=1
  local port_holder
  port_holder=$(ss -Hltnp "sport = :$SERVE_PORT" 2>/dev/null | grep -v "users:((\"electron\"" || true)
  [ -n "$port_holder" ] && port_ok=0
  need_row REQUIRED "port-${SERVE_PORT}-not-held-by-another-user" "$port_ok" "port must be free or already ours"

  local ufw_state="unknown"
  command -v ufw >/dev/null 2>&1 && ufw_state=$(ufw status 2>/dev/null | head -1 || echo unknown)
  echo "POSTURE   ufw-state                   POSTURE   $ufw_state"

  local sandbox_mode="sandboxed"
  [ "${DWS_SERVE_NO_SANDBOX:-}" = "1" ] && sandbox_mode="no-sandbox (accepted contingency, T-02-05)"
  echo "POSTURE   sandbox-mode                POSTURE   $sandbox_mode"

  if [ "$sha_ok" != 1 ] || [ "$disk_ok" != 1 ] || [ "$xvfb_ok" != 1 ] || [ "$node24_ok" != 1 ] || [ "$electron_ok" != 1 ] || [ "$port_ok" != 1 ]; then
    echo "PREFLIGHT_REFUSED"
    exit 1
  fi

  if ! id "$SVC_USER" >/dev/null 2>&1; then
    useradd --system --create-home --home-dir "$SVC_HOME" --shell /bin/bash --user-group "$SVC_USER"
  fi
  chmod 700 "$SVC_HOME"
  local groups
  groups=$(id -nG "$SVC_USER")
  if echo "$groups" | grep -qE '(^|[[:space:]])(sudo|adm|kobii)([[:space:]]|$)'; then
    echo "REFUSED: $SVC_USER holds a privileged group: $groups" >&2
    exit 2
  fi

  mkdir -p "$SVC_ROOT/node24" "$SVC_ROOT/agent-bin" "$SVC_ROOT/writable-vite"
  chown -R "$SVC_USER:$SVC_USER" "$SVC_ROOT"

  local short="${sha:0:7}"
  local svc_checkout="$SVC_CHECKOUT_ROOT/$short"
  mkdir -p "$SVC_CHECKOUT_ROOT"
  if [ ! -d "$svc_checkout" ]; then
    git -c safe.directory='*' clone --depth 1 --branch "dws-p2-$short" "file://$CLONE_DIR" "$svc_checkout" 2>/dev/null \
      || git -c safe.directory='*' clone --depth 1 "file://$CLONE_DIR" "$svc_checkout"
  fi
  git -C "$svc_checkout" checkout --detach "$sha" 2>/dev/null || git -C "$svc_checkout" fetch "file://$CLONE_DIR" "$sha" && git -C "$svc_checkout" checkout --detach "$sha"
  chown -R "$SVC_USER:$SVC_USER" "$svc_checkout"

  local svc_head
  svc_head=$(runuser -u "$SVC_USER" -- git -C "$svc_checkout" rev-parse HEAD)
  if [ "$svc_head" = "$sha" ]; then
    echo "SVC_FENCE_OK $sha"
  else
    echo "SVC_FENCE_MISMATCH expected=$sha actual=$svc_head"
    exit 3
  fi

  local artifact_dest="$SVC_ROOT/$(basename "$artifact")"
  install -o "$SVC_USER" -g "$SVC_USER" -m 600 "$artifact" "$artifact_dest"
  runuser -u "$SVC_USER" -- tar -xzf "$artifact_dest" -C "$svc_checkout"

  mkdir -p "$svc_checkout/node_modules"

  # Agent CLIs (CTX-CLI-3, later plans): bind a resolved binary/package read-only; never a path
  # under kobii's real ~/.claude or ~/.codex -- binaries may be shared, credentials never.
  local claude_bind="" codex_bind=""
  for name in claude codex; do
    local resolved
    resolved=$(runuser -u kobii -- bash -lc "command -v $name" 2>/dev/null || true)
    if [ -n "$resolved" ]; then
      resolved=$(readlink -f "$resolved")
      case "$resolved" in
        /home/kobii/.claude/*|/home/kobii/.codex/*)
          echo "AGENT_BIN_REFUSED name=$name path=$resolved"
          ;;
        *)
          local dest="$SVC_ROOT/agent-bin/$name"
          [ -e "$dest" ] || ln -s "$resolved" "$dest"
          if [ "$name" = "claude" ]; then claude_bind="BindReadOnlyPaths=$resolved:$dest"; fi
          if [ "$name" = "codex" ]; then codex_bind="BindReadOnlyPaths=$resolved:$dest"; fi
          ;;
      esac
    fi
  done

  local vite_bind=""
  if [ -d "/home/kobii/orca-x/node_modules/.vite" ]; then
    vite_bind="BindPaths=$SVC_ROOT/writable-vite:$svc_checkout/node_modules/.vite"
  fi

  local no_sandbox_flag=""
  [ "${DWS_SERVE_NO_SANDBOX:-}" = "1" ] && no_sandbox_flag=" --no-sandbox"

  cat > "/etc/systemd/system/$UNIT_NAME" <<UNIT
[Unit]
Description=Orca DWS-P2 serve (loopback-pinned, orca-svc)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$svc_checkout
Environment=LIBGL_ALWAYS_SOFTWARE=1
Environment=PATH=$SVC_ROOT/node24/bin:/usr/local/bin:/usr/bin:/bin
BindReadOnlyPaths=/home/kobii/orca-x/node_modules:$svc_checkout/node_modules
BindReadOnlyPaths=$NODE24_BIN/..:$SVC_ROOT/node24
${claude_bind}
${codex_bind}
${vite_bind}
NoNewPrivileges=yes
PrivateTmp=yes
StandardOutput=append:$SVC_ROOT/serve-ready.jsonl
StandardError=journal
KillMode=mixed
Restart=on-failure
RestartPreventExitStatus=3
RestartSec=5
ExecStart=/usr/bin/xvfb-run -a $svc_checkout/node_modules/electron/dist/electron $svc_checkout serve --bind-host 127.0.0.1 --port $SERVE_PORT --pairing-address 127.0.0.1 --json${no_sandbox_flag}

[Install]
WantedBy=multi-user.target
UNIT
  # Why: this file precedes the systemd unit's user, so StandardOutput=append: cannot create it.
  touch "$SVC_ROOT/serve-ready.jsonl"
  chown "$SVC_USER:$SVC_USER" "$SVC_ROOT/serve-ready.jsonl"
  chmod 600 "$SVC_ROOT/serve-ready.jsonl"

  systemctl daemon-reload
  systemctl enable "$UNIT_NAME"
  systemctl restart "$UNIT_NAME"

  local waited=0
  local ready_line=""
  while [ "$waited" -lt 120 ]; do
    ready_line=$(tail -n 20 "$SVC_ROOT/serve-ready.jsonl" 2>/dev/null | grep boundEndpoint | tail -1 || true)
    [ -n "$ready_line" ] && break
    sleep 2
    waited=$((waited + 2))
  done

  if [ -z "$ready_line" ]; then
    echo "READY_TIMEOUT waited=${waited}s"
    systemctl status "$UNIT_NAME" --no-pager -l | tail -30
    exit 7
  fi

  local bound_endpoint pairing_sha12
  bound_endpoint=$(echo "$ready_line" | python3 -c 'import json,sys; print(json.load(sys.stdin)["boundEndpoint"])' 2>/dev/null)
  pairing_sha12=$(echo "$ready_line" | python3 -c '
import json, sys, hashlib
d = json.load(sys.stdin)
p = d.get("pairing") or {}
url = p.get("url")
print(hashlib.sha256(url.encode()).hexdigest()[:12] if url else "none")
')
  echo "READY boundEndpoint=$bound_endpoint pairingSha12=$pairing_sha12"
  ss -Hltnp "sport = :$SERVE_PORT"
}

# --- ready-json / status / ps-capture ---------------------------------------
cmd_ready_json() {
  tail -n 50 "$SVC_ROOT/serve-ready.jsonl" 2>/dev/null | grep boundEndpoint | tail -1
}

cmd_status() {
  systemctl is-active "$UNIT_NAME"
  systemctl show "$UNIT_NAME" -p MainPID --value
  ps -o pid,ppid,user,rss,etimes,args --forest -u "$SVC_USER"
}

cmd_ps_capture() {
  local count="${1:-1}" interval="${2:-1}"
  local i=0
  while [ "$i" -lt "$count" ]; do
    echo "CAPTURE $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    ps -o pid,ppid,user,rss,etimes,args --forest -u "$SVC_USER"
    i=$((i + 1))
    [ "$i" -lt "$count" ] && sleep "$interval"
  done
}

case "$cmd" in
  fetch-bundle) cmd_fetch_bundle "$@" ;;
  build) cmd_build "$@" ;;
  install) cmd_install "$@" ;;
  ready-json) cmd_ready_json "$@" ;;
  status) cmd_status "$@" ;;
  ps-capture) cmd_ps_capture "$@" ;;
  *) echo "usage: $0 {fetch-bundle|build|install|ready-json|status|ps-capture} ..." >&2; exit 2 ;;
esac
