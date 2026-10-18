#!/usr/bin/env bash
# GEX44 provisioner for the phase-15/16/17/20/22/23 two-host rungs; verbs: create status witness procs teardown install-stub
# seed-p16 seed-p17 seed-p17-capsule verify-p17 seed-p19 git-compat-p16 seed-p20 edit-prepare-p20 stat-shim-p20 serve-p20 serve-query-p20 serve-p22 pairing-p22
# serve-stop-p22 old-relay-p23, and for phase 70 create-svc seed-svc svc-backup svc-state svc-restore svc-teardown.
# Never deletes anything, except svc-teardown, which removes only what a phase-70 leg created in the
# service account's home (its transfer project dir, and a relay install that was absent before), by exact path.
set -eu

VERB="${1:-}"
ROOT="${2:-}"
EXTRA="${3:-}"
EXTRA2="${4:-}"

case "$ROOT" in
  /tmp/orca-hwf-p1[56]-) echo "REFUSED root=$ROOT"; exit 2 ;;
  /tmp/orca-hwf-p1[56]-*[!0-9A-Za-z]*) echo "REFUSED root=$ROOT"; exit 2 ;;
  /tmp/orca-hwf-p1[56]-*) ;;
  /tmp/orca-hwf-p17-) echo "REFUSED root=$ROOT"; exit 2 ;;
  /tmp/orca-hwf-p17-*[!0-9A-Za-z]*) echo "REFUSED root=$ROOT"; exit 2 ;;
  /tmp/orca-hwf-p17-*) ;;
  /tmp/orca-hwf-p20-) echo "REFUSED root=$ROOT"; exit 2 ;;
  /tmp/orca-hwf-p20-*[!0-9A-Za-z]*) echo "REFUSED root=$ROOT"; exit 2 ;;
  /tmp/orca-hwf-p20-*) ;;
  /tmp/orca-hwf-p22-) echo "REFUSED root=$ROOT"; exit 2 ;;
  /tmp/orca-hwf-p22-*[!0-9A-Za-z]*) echo "REFUSED root=$ROOT"; exit 2 ;;
  /tmp/orca-hwf-p22-*) ;;
  /tmp/orca-hwf-p23-) echo "REFUSED root=$ROOT"; exit 2 ;;
  /tmp/orca-hwf-p23-*[!0-9A-Za-z]*) echo "REFUSED root=$ROOT"; exit 2 ;;
  /tmp/orca-hwf-p23-*) ;;
  /tmp/orca-hwf-p70-) echo "REFUSED root=$ROOT"; exit 2 ;;
  /tmp/orca-hwf-p70-*[!0-9A-Za-z]*) echo "REFUSED root=$ROOT"; exit 2 ;;
  /tmp/orca-hwf-p70-*) ;;
  *) echo "REFUSED root=$ROOT"; exit 2 ;;
esac

# Phase 70 logs in as the service account with its REAL home (the only home holding a provider login).
SVC_USER=orca-svc
SVC_HOME=/home/orca-svc
LOGIN_USER=$(id -un)
case "$ROOT" in /tmp/orca-hwf-p70-*) LOGIN_USER=$SVC_USER ;; esac

# One flag set for every seed init/add/commit so both hosts mint the same first commit (W10).
G="git -c core.autocrlf=false -c core.safecrlf=false -c commit.gpgsign=false -c core.hooksPath= -c init.defaultBranch=main -c user.name=hwf16 -c user.email=hwf16@example.invalid"

seed_git() {
  GIT_AUTHOR_NAME=hwf16 GIT_AUTHOR_EMAIL=hwf16@example.invalid GIT_AUTHOR_DATE='2026-10-01T00:00:00+0000' \
  GIT_COMMITTER_NAME=hwf16 GIT_COMMITTER_EMAIL=hwf16@example.invalid GIT_COMMITTER_DATE='2026-10-01T00:00:00+0000' \
    $G "$@"
}

USER_NAME=$(id -un)

scan_root_procs() {
  # Lists processes whose cwd or argv mention the root, excluding this script's own ancestry.
  ORCA_HWF_ROOT="$ROOT" python3 - <<'PY'
import os
root = os.environ["ORCA_HWF_ROOT"]
skip = set()
p = os.getpid()
while p > 1:
    skip.add(p)
    try:
        with open("/proc/%d/stat" % p) as f:
            p = int(f.read().rsplit(")", 1)[1].split()[1])
    except Exception:
        break
n = 0
for d in sorted(os.listdir("/proc")):
    if not d.isdigit() or int(d) in skip:
        continue
    pid = int(d)
    try:
        cwd = os.readlink("/proc/%d/cwd" % pid)
    except Exception:
        cwd = ""
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as f:
            argv = f.read().replace(b"\0", b" ").decode("utf-8", "replace").strip()
    except Exception:
        argv = ""
    if root not in cwd and root not in argv:
        continue
    try:
        with open("/proc/%d/stat" % pid) as f:
            ppid = int(f.read().rsplit(")", 1)[1].split()[1])
    except Exception:
        ppid = -1
    n += 1
    print("PROC %d %d %s %s" % (pid, ppid, cwd or "-", argv or "-"))
print("PROC_COUNT=%d" % n)
PY
}

sshd_pid() {
  if [ -f "$ROOT/svc/sshd.pid" ]; then cat "$ROOT/svc/sshd.pid"
  elif [ -f "$ROOT/sshd.pid" ]; then cat "$ROOT/sshd.pid"; else echo 0; fi
}

via_private_sshd() {
  ssh -n -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile="$ROOT/kh_probe" \
    -o IdentitiesOnly=yes -i "$ROOT/client_key" -p "$(cat "$ROOT/port")" "$LOGIN_USER@127.0.0.1" "$1"
}

# Processes of the service account outside the serve's tree that were not there at create-svc.
svc_new_pids() {
  SERVE=$(systemctl show orca-dws-serve -p MainPID --value)
  TREE=" $SERVE "
  FRONT="$SERVE"
  while [ -n "$FRONT" ]; do
    NEXT=""
    for P in $FRONT; do
      for C in $(ps -o pid= --ppid "$P" 2>/dev/null); do TREE="$TREE$C "; NEXT="$NEXT $C"; done
    done
    FRONT="$NEXT"
  done
  for P in $(ps -u "$SVC_USER" -o pid=); do
    case "$TREE" in *" $P "*) continue ;; esac
    grep -qx "$P" "$ROOT/svc-pids-before" && continue
    echo "$P"
  done
}

svc_state() {
  sudo -n bash -s -- "$SVC_HOME" <<'STATE'
H="$1"
echo "SETTINGS_SHA=$(sha256sum "$H/.claude/settings.json" 2>/dev/null | cut -c1-64 || echo absent)"
echo "AGENT_HOOKS_SHA=$(cd "$H/.orca/agent-hooks" 2>/dev/null && find . -type f -exec sha256sum {} + | sort | sha256sum | cut -c1-64 || echo absent)"
if [ -d "$H/.orca-remote" ]; then echo "ORCA_REMOTE=present"; else echo "ORCA_REMOTE=absent"; fi
echo "CLAUDE_JSON_SHA=$(sha256sum "$H/.claude.json" 2>/dev/null | cut -c1-64 || echo absent)"
echo "HWF_CLAUDE_PROJECTS=$(python3 -c 'import json,sys; print(sum(k.startswith("/tmp/orca-hwf-") for k in json.load(open(sys.argv[1])).get("projects", {})))' "$H/.claude.json" 2>/dev/null || echo unknown)"
echo "SERVE_PID=$(systemctl show orca-dws-serve -p MainPID --value)"
STATE
}

case "$VERB" in
  create)
    if [ -f "$ROOT/sshd_config" ]; then echo "REFUSED exists root=$ROOT"; exit 3; fi
    mkdir -p "$ROOT/home" "$ROOT/repos"
    ssh-keygen -q -t ed25519 -N '' -C hwf-host -f "$ROOT/hostkey"
    ssh-keygen -q -t ed25519 -N '' -C hwf-client -f "$ROOT/client_key"
    PUB=$(cat "$ROOT/client_key.pub")
    echo "environment=\"HOME=$ROOT/home\" $PUB" > "$ROOT/authorized_keys"
    PORT=$(python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()")
    echo "$PORT" > "$ROOT/port"
    cat > "$ROOT/sshd_config" <<CFG
ListenAddress 127.0.0.1
Port $PORT
HostKey $ROOT/hostkey
AuthorizedKeysFile $ROOT/authorized_keys
PidFile $ROOT/sshd.pid
UsePAM no
PermitUserEnvironment yes
StrictModes no
PasswordAuthentication no
Subsystem sftp internal-sftp
CFG
    chmod 600 "$ROOT/hostkey" "$ROOT/client_key"
    /usr/sbin/sshd -f "$ROOT/sshd_config" -E "$ROOT/sshd.log" < /dev/null > /dev/null 2>&1
    sleep 1
    NONCE=$(python3 -c "import secrets;print(secrets.token_hex(8))")
    REPO="$ROOT/repos/p15-repo"
    mkdir -p "$REPO"
    git -C "$REPO" init -q
    git -C "$REPO" config user.name hwf
    git -C "$REPO" config user.email hwf@example.invalid
    echo "HWF_SEED_$NONCE" > "$REPO/seed.txt"
    git -C "$REPO" add seed.txt
    git -C "$REPO" commit -q -m "hwf p15 seed"
    echo "ROOT=$ROOT"
    echo "PORT=$PORT"
    echo "FP=$(ssh-keygen -lf "$ROOT/hostkey.pub" | awk '{print $2}')"
    echo "HOSTNAME=$(hostname)"
    echo "USER=$USER_NAME"
    echo "REPO=$REPO"
    echo "SEED_NONCE=$NONCE"
    echo "SEED_HEAD=$(git -C "$REPO" rev-parse HEAD)"
    echo "SSHD_PID=$(sshd_pid)"
    via_private_sshd 'echo HOME_SEEN=$HOME'
    ;;
  status)
    if [ -f "$ROOT/sshd_config" ]; then
      SP=$(sshd_pid)
      if [ "$SP" != 0 ] && kill -0 "$SP" 2>/dev/null; then echo "SSHD_ALIVE=yes"; else echo "SSHD_ALIVE=no"; fi
      echo "PORT=$(cat "$ROOT/port")"
    else
      echo "REFUSED no-root=$ROOT"; exit 3
    fi
    cat > "$ROOT/probe.sh" <<'PROBE'
echo "CURL=$(command -v curl || echo none)"
echo "PROVIDER_CODEX=$(command -v codex || echo none)"
echo "PROVIDER_CLAUDE=$(command -v claude || echo none)"
echo "LOGIN_PATH=$PATH"
PROBE
    SP=$(sshd_pid)
    if [ "$SP" != 0 ] && kill -0 "$SP" 2>/dev/null; then via_private_sshd "bash -l $ROOT/probe.sh"; fi
    ;;
  install-stub)
    if [ ! -f "$ROOT/sshd_config" ]; then echo "REFUSED no-root=$ROOT"; exit 3; fi
    mkdir -p "$ROOT/bin"
    # Marker is split across printf args so the typed command never contains the joined text.
    cat > "$ROOT/bin/hwf-agent-stub" <<'STUB'
#!/usr/bin/env bash
printf '%s%s\n' 'HWF_AGENT_STUB_' 'READY'
while read -r _; do :; done
STUB
    chmod +x "$ROOT/bin/hwf-agent-stub"
    echo "STUB=$ROOT/bin/hwf-agent-stub"
    ;;
  witness)
    REAL_HOME=$(getent passwd "$USER_NAME" | cut -d: -f6)
    if [ -f "$REAL_HOME/.ssh/known_hosts" ]; then
      echo "KNOWN_HOSTS_SHA=$(sha256sum "$REAL_HOME/.ssh/known_hosts" | awk '{print $1}')"
    else
      echo "KNOWN_HOSTS_SHA=absent"
    fi
    echo "ORCA_X_HEAD=$(git -C /home/kobii/orca-x rev-parse HEAD)"
    if [ -d "$REAL_HOME/.orca-remote" ]; then
      echo "REAL_RELAY_LISTING_SHA=$(find "$REAL_HOME/.orca-remote" -maxdepth 2 -printf '%P %T@\n' | sort | sha256sum | awk '{print $1}')"
    else
      echo "REAL_RELAY_LISTING_SHA=absent"
    fi
    ;;
  procs)
    scan_root_procs
    ;;
  teardown)
    PIDS=$(scan_root_procs | awk '$1=="PROC"{print $2}')
    SP=$(sshd_pid)
    for P in $PIDS $SP; do
      if [ "$P" != 0 ]; then kill "$P" 2>/dev/null || true; fi
    done
    I=0
    while [ "$I" -lt 10 ]; do
      LEFT=$(scan_root_procs | awk '/^PROC_COUNT=/{print substr($0,12)}')
      if [ "$LEFT" = 0 ]; then break; fi
      sleep 0.5
      I=$((I + 1))
    done
    echo "REMAINING=$LEFT"
    ;;
  seed-p16)
    if [ ! -f "$ROOT/sshd_config" ]; then echo "REFUSED no-root=$ROOT"; exit 3; fi
    case "$EXTRA" in
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
      *) echo "REFUSED nonce=$EXTRA"; exit 2 ;;
    esac
    NONCE="$EXTRA"
    REPLICA="$ROOT/repos/p16-replica"
    FORK="$ROOT/repos/p16-fork"
    SHALLOW="$ROOT/repos/p16-shallow"
    UNBORN="$ROOT/repos/p16-unborn"
    LATE="$ROOT/repos/p16-late"
    if [ -e "$REPLICA" ]; then echo "REFUSED exists=$REPLICA"; exit 3; fi
    mkdir -p "$REPLICA"
    seed_git -C "$REPLICA" init -q
    printf 'HWF16_%s\n' "$NONCE" > "$REPLICA/seed.txt"
    seed_git -C "$REPLICA" add seed.txt
    seed_git -C "$REPLICA" commit -q -m 'hwf p16 seed'
    SEED_ROOT=$(git -C "$REPLICA" rev-parse HEAD)
    printf '%s\n' "$(hostname)" > "$REPLICA/host.txt"
    $G -C "$REPLICA" add host.txt
    $G -C "$REPLICA" commit -q -m 'hwf p16 host commit'
    git clone -q "$REPLICA" "$FORK"
    git -C "$FORK" remote remove origin
    printf 'fork of %s\n' "$NONCE" > "$FORK/fork.txt"
    $G -C "$FORK" add fork.txt
    $G -C "$FORK" commit -q -m 'hwf p16 fork commit'
    git clone -q --depth 1 "file://$REPLICA" "$SHALLOW"
    git -C "$SHALLOW" remote remove origin
    mkdir -p "$UNBORN"
    $G -C "$UNBORN" init -q
    mkdir -p "$LATE"
    $G -C "$LATE" init -q
    printf 'HWF16_LATE_%s\n' "$NONCE" > "$LATE/late.txt"
    $G -C "$LATE" add late.txt
    $G -C "$LATE" commit -q -m 'hwf p16 late repo'
    echo "SEED_ROOT=$SEED_ROOT"
    echo "REPLICA_PATH=$REPLICA"
    echo "REPLICA_HEAD=$(git -C "$REPLICA" rev-parse HEAD)"
    echo "FORK_PATH=$FORK"
    echo "FORK_HEAD=$(git -C "$FORK" rev-parse HEAD)"
    echo "SHALLOW_PATH=$SHALLOW"
    echo "SHALLOW_IS_SHALLOW=$(git -C "$SHALLOW" rev-parse --is-shallow-repository)"
    echo "UNBORN_PATH=$UNBORN"
    echo "LATE_PATH=$LATE"
    echo "LATE_HEAD=$(git -C "$LATE" rev-parse HEAD)"
    ;;
  seed-p17)
    if [ ! -f "$ROOT/sshd_config" ]; then echo "REFUSED no-root=$ROOT"; exit 3; fi
    case "$EXTRA" in
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
      *) echo "REFUSED nonce=$EXTRA"; exit 2 ;;
    esac
    NONCE="$EXTRA"
    P17="$ROOT/repos/p17-replica"
    if [ -e "$P17" ]; then echo "REFUSED exists=$P17"; exit 3; fi
    mkdir -p "$P17"
    seed_git -C "$P17" init -q
    printf 'HWF16_%s\n' "$NONCE" > "$P17/seed.txt"
    seed_git -C "$P17" add seed.txt
    seed_git -C "$P17" commit -q -m 'hwf p16 seed'
    SEED_ROOT=$(git -C "$P17" rev-parse HEAD)
    for N in 1 2; do
      printf 'remote %s %s\n' "$N" "$NONCE" > "$P17/remote$N.txt"
      $G -C "$P17" add "remote$N.txt"
      $G -C "$P17" commit -q -m "hwf p17 remote commit $N"
    done
    echo "SEED_ROOT=$SEED_ROOT"
    echo "P17_REPLICA_PATH=$P17"
    echo "P17_REPLICA_HEAD=$(git -C "$P17" rev-parse HEAD)"
    echo "P17_REMOTE_AHEAD=2"
    ;;
  seed-p17-capsule)
    # Row 64: the capsule push target (distinct from the row-65 seed-p17 replica).
    if [ ! -f "$ROOT/sshd_config" ]; then echo "REFUSED no-root=$ROOT"; exit 3; fi
    case "$EXTRA" in
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
      *) echo "REFUSED nonce=$EXTRA"; exit 2 ;;
    esac
    TARGET="$ROOT/repos/p17-target"
    if [ -e "$TARGET" ]; then echo "REFUSED exists=$TARGET"; exit 3; fi
    mkdir -p "$TARGET"
    seed_git -C "$TARGET" init -q
    printf 'HWF17_%s\n' "$EXTRA" > "$TARGET/seed.txt"
    seed_git -C "$TARGET" add seed.txt
    seed_git -C "$TARGET" commit -q -m 'hwf p17 seed'
    echo "TARGET_PATH=$TARGET"
    echo "TARGET_HEAD=$(git -C "$TARGET" rev-parse HEAD)"
    ;;
  verify-p17)
    # Reads the capsule the laptop pushed: ref shape, W/I/U layout, the dirty content, and that the target worktree is untouched.
    if [ ! -f "$ROOT/sshd_config" ]; then echo "REFUSED no-root=$ROOT"; exit 3; fi
    case "$EXTRA" in
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
      *) echo "REFUSED nonce=$EXTRA"; exit 2 ;;
    esac
    TARGET="$ROOT/repos/p17-target"
    if [ ! -d "$TARGET/.git" ]; then echo "REFUSED no-target=$TARGET"; exit 3; fi
    REFS=$(git -C "$TARGET" for-each-ref --format='%(refname)' refs/orca/capsules/)
    echo "CAPSULE_REFS=$(printf '%s' "$REFS" | grep -c . || true)"
    REF=$(printf '%s\n' "$REFS" | head -n 1)
    W=$(git -C "$TARGET" rev-parse "$REF^{commit}")
    echo "CAPSULE_REF=$REF"
    echo "CAPSULE_REF_MATCHES_W=$([ "$REF" = "refs/orca/capsules/$W" ] && echo yes || echo no)"
    echo "CAPSULE_FSCK=$(git -C "$TARGET" fsck --no-dangling >/dev/null 2>&1 && echo ok || echo bad)"
    PARENTS=$(git -C "$TARGET" rev-list --parents -n 1 "$W" | wc -w)
    echo "CAPSULE_PARENTS=$((PARENTS - 1))"
    echo "CAPSULE_BASE_IS_HEAD=$([ "$(git -C "$TARGET" rev-parse "$W^1")" = "$(git -C "$TARGET" rev-parse HEAD)" ] && echo yes || echo no)"
    echo "CAPSULE_W_TRACKED=$(git -C "$TARGET" show "$W:seed.txt")"
    echo "CAPSULE_I_STAGED=$(git -C "$TARGET" show "$W^2:staged.txt")"
    echo "CAPSULE_U_UNTRACKED=$(git -C "$TARGET" show "$W^3:untracked.txt")"
    echo "TARGET_STATUS_LINES=$(git -C "$TARGET" status --porcelain | wc -l)"
    echo "TARGET_HEAD_UNCHANGED=$(git -C "$TARGET" rev-parse HEAD)"
    ;;
  seed-p19)
    # Phase 19 reuses a p17-shaped root (the guard is not widened). A diverged replica: same seed commit as the
    # seed root, then one commit that rewrites seed.txt, so a local rewrite of the same file conflicts.
    if [ ! -f "$ROOT/sshd_config" ]; then echo "REFUSED no-root=$ROOT"; exit 3; fi
    case "$ROOT" in /tmp/orca-hwf-p17-*) ;; *) echo "REFUSED root=$ROOT"; exit 2 ;; esac
    case "$EXTRA" in
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
      *) echo "REFUSED nonce=$EXTRA"; exit 2 ;;
    esac
    NONCE="$EXTRA"
    P19="$ROOT/repos/p19-replica"
    if [ -e "$P19" ]; then echo "REFUSED exists=$P19"; exit 3; fi
    mkdir -p "$P19"
    seed_git -C "$P19" init -q
    printf 'HWF16_%s\n' "$NONCE" > "$P19/seed.txt"
    seed_git -C "$P19" add seed.txt
    seed_git -C "$P19" commit -q -m 'hwf p16 seed'
    SEED_ROOT=$(git -C "$P19" rev-parse HEAD)
    printf 'remote side %s\n' "$NONCE" > "$P19/seed.txt"
    $G -C "$P19" add seed.txt
    $G -C "$P19" commit -q -m 'hwf p19 remote rewrite'
    echo "SEED_ROOT=$SEED_ROOT"
    echo "P19_REPLICA_PATH=$P19"
    echo "P19_REPLICA_HEAD=$(git -C "$P19" rev-parse HEAD)"
    ;;
  git-compat-p16)
    if [ ! -f "$ROOT/sshd_config" ]; then echo "REFUSED no-root=$ROOT"; exit 3; fi
    GB="git"
    if [ -n "$EXTRA" ]; then GB="$EXTRA"; fi
    echo "GIT_BIN=$GB"
    echo "GIT_VERSION=$("$GB" --version 2>&1 | tr '\n' '|')"
    for NAME in replica shallow unborn; do
      P="$ROOT/repos/p16-$NAME"
      UP=$(printf '%s' "$NAME" | tr 'a-z' 'A-Z')
      OUT=$("$GB" -C "$P" rev-parse --is-shallow-repository --git-common-dir 2>&1) && EC=0 || EC=$?
      echo "GC_${UP}_SHALLOW_EXIT=$EC"
      echo "GC_${UP}_SHALLOW_OUT=$(printf '%s' "$OUT" | tr '\n' '|')"
      OUT=$("$GB" -C "$P" log --first-parent --max-parents=0 --format=%H HEAD 2>&1) && EC=0 || EC=$?
      echo "GC_${UP}_ROOTLOG_EXIT=$EC"
      echo "GC_${UP}_ROOTLOG_OUT=$(printf '%s' "$OUT" | tr '\n' '|')"
      OUT=$("$GB" -C "$P" for-each-ref --count=1 '--format=%(objectname)' 2>&1) && EC=0 || EC=$?
      echo "GC_${UP}_REFS_EXIT=$EC"
      echo "GC_${UP}_REFS_OUT=$(printf '%s' "$OUT" | tr '\n' '|')"
    done
    ;;
  seed-p20)
    if [ ! -f "$ROOT/sshd_config" ]; then echo "REFUSED no-root=$ROOT"; exit 3; fi
    case "$EXTRA" in
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
      *) echo "REFUSED nonce"; exit 2 ;;
    esac
    PROJECT="$ROOT/repos/p20-project"
    if [ -e "$PROJECT" ]; then echo "REFUSED exists=$PROJECT"; exit 3; fi
    mkdir -p "$PROJECT"
    seed_git -C "$PROJECT" init -q
    printf 'hwf p20 environment contract project\n' > "$PROJECT/README.md"
    seed_git -C "$PROJECT" add README.md
    seed_git -C "$PROJECT" commit -q -m 'hwf p20 seed'
    # Values reach python through the environment only; the nonce is never echoed.
    ORCA_HWF_ROOT="$ROOT" ORCA_HWF_NONCE="$EXTRA" python3 - <<'PY'
import os
root = os.environ["ORCA_HWF_ROOT"]
nonce = os.environ["ORCA_HWF_NONCE"]
shim = '"$HOME/p20-bin/orca-hwf-p20-shim"'
prepare = ('mkdir -p "$HOME/p20-bin" && printf \'#!/bin/sh\\necho orca-hwf-p20-shim 1.0.0\\n\' > '
           + shim + ' && chmod +x ' + shim)
yaml_text = "\n".join([
    "requirements:",
    "  - id: git-ok",
    "    kind: command",
    "    name: git",
    "    version: \">=2.25\"",
    "  - id: git-too-new",
    "    kind: command",
    "    name: git",
    "    version: \">=99\"",
    "  - id: absent-tool",
    "    kind: command",
    "    name: orca-hwf-p20-absent-tool",
    "  - id: mac-only",
    "    kind: command",
    "    name: git",
    "    platforms:",
    "      - os: darwin",
    "  - id: shim",
    "    kind: command",
    "    name: orca-hwf-p20-shim",
    "    prepare: |",
    "      " + prepare,
    "  - id: gpu",
    "    kind: gpu",
    "  - id: token",
    "    kind: env",
    "    name: ORCA_HWF_P20_TOKEN",
    "",
])
with open(os.path.join(root, "repos", "p20-project", "orca.yaml"), "w") as f:
    f.write(yaml_text)
with open(os.path.join(root, "home", ".profile"), "w") as f:
    f.write("export ORCA_HWF_P20_TOKEN=HWF20TOK_" + nonce + "\n")
    f.write('export PATH="$HOME/p20-bin:$PATH"\n')
# Presence probe for the login shell; the variable test is assembled here so it never appears as shell text above.
probe = ("case \":$PATH:\" in *\":$HOME/p20-bin:\"*) echo LOGIN_HAS_P20_BIN=yes ;; *) echo LOGIN_HAS_P20_BIN=no ;; esac\n"
         "if [ -n \"${" + "ORCA_HWF_P20_TOKEN" + "+x}\" ]; then echo LOGIN_HAS_TOKEN=yes; else echo LOGIN_HAS_TOKEN=no; fi\n")
with open(os.path.join(root, "p20-login-probe.sh"), "w") as f:
    f.write(probe)
PY
    echo "PROJECT_PATH=$PROJECT"
    echo "CONTRACT_SHA256=$(sha256sum "$PROJECT/orca.yaml" | awk '{print $1}')"
    ORCA_HWF_YAML="$PROJECT/orca.yaml" python3 - <<'PY'
import hashlib, os, yaml
doc = yaml.safe_load(open(os.environ["ORCA_HWF_YAML"]).read())
row = [r for r in doc["requirements"] if r.get("id") == "shim"][0]
print("PREPARE_SHA256=" + hashlib.sha256(row["prepare"].encode("utf-8")).hexdigest())
PY
    echo "SHIM_DIR=$ROOT/home/p20-bin"
    echo "SENTINEL_SHA256=$(printf 'HWF20TOK_%s' "$EXTRA" | sha256sum | awk '{print $1}')"
    via_private_sshd "bash -l $ROOT/p20-login-probe.sh"
    ;;
  edit-prepare-p20)
    if [ ! -f "$ROOT/repos/p20-project/orca.yaml" ]; then echo "REFUSED no-project=$ROOT"; exit 3; fi
    # Appends a command line inside the prepare block scalar, so the parsed value (and its hash) changes.
    ORCA_HWF_YAML="$ROOT/repos/p20-project/orca.yaml" python3 - <<'PY'
import hashlib, os, yaml
path = os.environ["ORCA_HWF_YAML"]
def prepare_of(text):
    doc = yaml.safe_load(text)
    return [r for r in doc["requirements"] if r.get("id") == "shim"][0]["prepare"]
text = open(path).read()
before = prepare_of(text)
lines = text.split("\n")
start = lines.index("    prepare: |")
end = start + 1
while end < len(lines) and lines[end].startswith("      "):
    end += 1
lines.insert(end, "      true # edited")
new_text = "\n".join(lines)
after = prepare_of(new_text)
if after == before:
    print("EDIT_NOOP=yes")
    raise SystemExit(4)
with open(path, "w") as f:
    f.write(new_text)
print("PREPARE_SHA256_BEFORE=" + hashlib.sha256(before.encode("utf-8")).hexdigest())
print("PREPARE_SHA256=" + hashlib.sha256(after.encode("utf-8")).hexdigest())
PY
    echo "CONTRACT_SHA256=$(sha256sum "$ROOT/repos/p20-project/orca.yaml" | awk '{print $1}')"
    ;;
  stat-shim-p20)
    if [ ! -f "$ROOT/sshd_config" ]; then echo "REFUSED no-root=$ROOT"; exit 3; fi
    SHIM="$ROOT/home/p20-bin/orca-hwf-p20-shim"
    if [ -f "$SHIM" ]; then
      echo "SHIM_PRESENT=yes"
      echo "SHIM_MTIME=$(stat -c %Y "$SHIM")"
    else
      echo "SHIM_PRESENT=no"
      echo "SHIM_MTIME=none"
    fi
    ;;
  serve-p20)
    if [ ! -f "$ROOT/repos/p20-project/orca.yaml" ]; then echo "REFUSED no-project=$ROOT"; exit 3; fi
    case "$EXTRA" in
      /home/kobii/orca-x|/home/kobii/orca-x/*) echo "REFUSED worktree=$EXTRA"; exit 2 ;;
      /home/kobii/*[!A-Za-z0-9_./-]*) echo "REFUSED worktree=$EXTRA"; exit 2 ;;
      /home/kobii/?*) ;;
      *) echo "REFUSED worktree=$EXTRA"; exit 2 ;;
    esac
    case "$EXTRA2" in
      ''|*[!A-Za-z0-9_./=\ -]*) echo "REFUSED launch"; exit 2 ;;
    esac
    if [ ! -d "$EXTRA" ]; then echo "REFUSED worktree-missing=$EXTRA"; exit 3; fi
    PORT=$(python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()")
    mkdir -p "$ROOT/serve-data"
    cd "$EXTRA"
    export PATH="/home/kobii/.orca-toolchain/node24/bin:$PATH"
    # shellcheck disable=SC2086
    # A dev-tree app picks its userData from ORCA_DEV_USER_DATA_PATH; the CLI finds it through ORCA_USER_DATA_PATH.
    setsid nohup env HOME="$ROOT/home" ORCA_USER_DATA_PATH="$ROOT/serve-data" ORCA_DEV_USER_DATA_PATH="$ROOT/serve-data" $EXTRA2 serve --port "$PORT" --bind-host 127.0.0.1 --no-pairing > "$ROOT/serve.log" 2>&1 < /dev/null &
    echo "SERVE_PORT=$PORT"
    echo "SERVE_PID=$!"
    ;;
  serve-query-p20)
    if [ ! -f "$ROOT/repos/p20-project/orca.yaml" ]; then echo "REFUSED no-project=$ROOT"; exit 3; fi
    case "$EXTRA" in
      /home/kobii/orca-x|/home/kobii/orca-x/*) echo "REFUSED worktree=$EXTRA"; exit 2 ;;
      /home/kobii/*[!A-Za-z0-9_./-]*) echo "REFUSED worktree=$EXTRA"; exit 2 ;;
      /home/kobii/?*) ;;
      *) echo "REFUSED worktree=$EXTRA"; exit 2 ;;
    esac
    cd "$EXTRA"
    export PATH="/home/kobii/.orca-toolchain/node24/bin:$PATH"
    # A fresh runtime holds no repos, so the project is added before it is measured.
    env HOME="$ROOT/home" ORCA_USER_DATA_PATH="$ROOT/serve-data" ORCA_DEV_CLI_INVOCATION=1 node out/cli/index.js repo add --path "$ROOT/repos/p20-project" --json > "$ROOT/serve-repo-add.json" 2>&1 && AEC=0 || AEC=$?
    echo "SERVE_REPO_ADD_EXIT=$AEC"
    env HOME="$ROOT/home" ORCA_USER_DATA_PATH="$ROOT/serve-data" ORCA_DEV_CLI_INVOCATION=1 node out/cli/index.js project requirements --repo "$ROOT/repos/p20-project" --json > "$ROOT/serve-query.json" 2> "$ROOT/serve-query.err" && QEC=0 || QEC=$?
    echo "SERVE_QUERY_EXIT=$QEC"
    ORCA_HWF_JSON="$ROOT/serve-query.json" python3 - <<'PY'
import json, os
try:
    doc = json.load(open(os.environ["ORCA_HWF_JSON"]))
except Exception as e:
    print("HWF20_R1_PARSE=failed " + type(e).__name__)
    raise SystemExit(0)
res = doc.get("result", doc)
m = res.get("measurement") or {}
os_name = (m.get("platform") or {}).get("os", "none")
version = "none"
for p in m.get("probes") or []:
    if p.get("id") == "git-ok":
        version = p.get("version") or "none"
print("HWF20_R1 status=%s hostKey=%s os=%s gitVersion=%s" % (m.get("status"), m.get("hostKey"), os_name, version))
PY
    echo "INDEPENDENT_GIT=$(git --version | awk '{print $3}')"
    ;;
  serve-p22)
    # Paired disposable serve for row 72: a remote worker runs the mission stub agent and reports worker_done.
    if [ ! -f "$ROOT/sshd_config" ]; then echo "REFUSED no-root=$ROOT"; exit 3; fi
    case "$EXTRA" in
      /home/kobii/orca-x|/home/kobii/orca-x/*) echo "REFUSED worktree=$EXTRA"; exit 2 ;;
      /home/kobii/*[!A-Za-z0-9_./-]*) echo "REFUSED worktree=$EXTRA"; exit 2 ;;
      /home/kobii/?*) ;;
      *) echo "REFUSED worktree=$EXTRA"; exit 2 ;;
    esac
    case "$EXTRA2" in
      ''|*[!A-Za-z0-9_./=\ -]*) echo "REFUSED launch"; exit 2 ;;
    esac
    if [ ! -d "$EXTRA" ]; then echo "REFUSED worktree-missing=$EXTRA"; exit 3; fi
    if [ -f "$ROOT/serve.pid" ]; then echo "REFUSED serve-exists=$(cat "$ROOT/serve.pid")"; exit 3; fi
    STUB="$EXTRA/tests/e2e/fixtures/mission-stub-agent"
    if [ ! -x "$STUB/codex" ]; then echo "REFUSED no-stub=$STUB"; exit 3; fi
    REPO="$ROOT/repos/p22-project"
    mkdir -p "$REPO" "$ROOT/serve-data" "$ROOT/home"
    if [ ! -d "$REPO/.git" ]; then
      seed_git init -q "$REPO"
      echo "p22 mission dispatch" > "$REPO/README.md"
      seed_git -C "$REPO" add README.md
      seed_git -C "$REPO" commit -q -m "p22 seed"
    fi
    PORT=$(python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()")
    cd "$EXTRA"
    export PATH="$STUB:/home/kobii/.orca-toolchain/node24/bin:$PATH"
    # shellcheck disable=SC2086
    setsid nohup env HOME="$ROOT/home" ORCA_USER_DATA_PATH="$ROOT/serve-data" ORCA_DEV_USER_DATA_PATH="$ROOT/serve-data" \
      ORCA_DEV_CLI_INVOCATION=1 ORCA_E2E_CLI_ENTRY="$EXTRA/out/cli/index.js" MISSION_STUB_HOST=gex44 \
      MISSION_STUB_LEDGER="$ROOT/stub-ledger.jsonl" \
      $EXTRA2 serve --port "$PORT" --bind-host 127.0.0.1 --pairing-address 127.0.0.1 > "$ROOT/serve.log" 2>&1 < /dev/null &
    echo "$!" > "$ROOT/serve.pid"
    echo "SERVE_PORT=$PORT"
    echo "SERVE_PID=$!"
    I=0
    while [ "$I" -lt 120 ] && ! grep -q '^Pairing URL: ' "$ROOT/serve.log"; do sleep 1; I=$((I + 1)); done
    if ! grep -q '^Pairing URL: ' "$ROOT/serve.log"; then echo "PAIRING_READY=no"; tail -20 "$ROOT/serve.log"; exit 4; fi
    # Why: the pairing code is a credential; it stays in a 0600 file, never in this verb's output.
    umask 077
    grep -m1 '^Pairing URL: ' "$ROOT/serve.log" | sed 's/^Pairing URL: //' > "$ROOT/pairing-url"
    echo "PAIRING_READY=yes"
    env HOME="$ROOT/home" ORCA_USER_DATA_PATH="$ROOT/serve-data" ORCA_DEV_CLI_INVOCATION=1 \
      node out/cli/index.js repo add --path "$REPO" --json > "$ROOT/serve-repo-add.json" 2>&1 && AEC=0 || AEC=$?
    echo "SERVE_REPO_ADD_EXIT=$AEC"
    echo "REMOTE_REPO_PATH=$REPO"
    ORCA_HWF_JSON="$ROOT/serve-repo-add.json" python3 - <<'PY'
import json, os
try:
    doc = json.load(open(os.environ["ORCA_HWF_JSON"]))
except Exception as e:
    print("REMOTE_REPO_ID=none parse-" + type(e).__name__)
    raise SystemExit(0)
res = doc.get("result", doc)
repo = res.get("repo", res) if isinstance(res, dict) else {}
print("REMOTE_REPO_ID=%s" % (repo.get("id") or "none"))
PY
    ;;
  pairing-p22)
    if [ ! -f "$ROOT/pairing-url" ]; then echo "REFUSED no-pairing=$ROOT"; exit 3; fi
    cat "$ROOT/pairing-url"
    ;;
  serve-stop-p22)
    if [ ! -f "$ROOT/serve.pid" ]; then echo "REFUSED no-serve=$ROOT"; exit 3; fi
    SID=$(cat "$ROOT/serve.pid")
    case "$SID" in ''|*[!0-9]*) echo "REFUSED pid"; exit 2 ;; esac
    echo "SERVE_SESSION_BEFORE=$(ps -o pid= -s "$SID" | wc -l)"
    kill -TERM -- "-$SID" 2>/dev/null || true
    I=0
    while [ "$I" -lt 20 ] && [ "$(ps -o pid= -s "$SID" | wc -l)" != 0 ]; do sleep 0.5; I=$((I + 1)); done
    if [ "$(ps -o pid= -s "$SID" | wc -l)" != 0 ]; then kill -KILL -- "-$SID" 2>/dev/null || true; sleep 1; fi
    echo "SERVE_SESSION_AFTER=$(ps -o pid= -s "$SID" | wc -l)"
    echo "STUB_LEDGER_LINES=$(wc -l < "$ROOT/stub-ledger.jsonl" 2>/dev/null || echo 0)"
    ;;
  old-relay-p23)
    # Phase 23: marks an "old relay" install (no sync/fabric capabilities) inside the root; writes only under $ROOT.
    if [ ! -f "$ROOT/sshd_config" ]; then echo "REFUSED no-root=$ROOT"; exit 3; fi
    mkdir -p "$ROOT/relay-old"
    printf '0.0.0\n' > "$ROOT/relay-old/.version"
    echo "P23_OLD_RELAY version=$(tr -d '\n' < "$ROOT/relay-old/.version") dir=$ROOT/relay-old"
    ;;
  create-svc)
    # Phase 70: a private sshd run AS the service account, so a login reaches its real home. Writes
    # only under $ROOT; the home is changed later by the client under test, and svc-restore undoes it.
    case "$ROOT" in /tmp/orca-hwf-p70-*) ;; *) echo "REFUSED svc-root=$ROOT"; exit 2 ;; esac
    if [ -e "$ROOT" ]; then echo "REFUSED exists root=$ROOT"; exit 3; fi
    sudo -n -u "$SVC_USER" true 2>/dev/null || { echo "REFUSED no-sudo-svc"; exit 3; }
    mkdir -p "$ROOT"
    ps -u "$SVC_USER" -o pid= | tr -d ' ' | sort -n > "$ROOT/svc-pids-before"
    ssh-keygen -q -t ed25519 -N '' -C hwf-host -f "$ROOT/hostkey"
    ssh-keygen -q -t ed25519 -N '' -C hwf-client -f "$ROOT/client_key"
    chmod 600 "$ROOT/hostkey" "$ROOT/client_key"
    PORT=$(python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()")
    echo "$PORT" > "$ROOT/port"
    sudo -n install -d -o "$SVC_USER" -m 755 "$ROOT/svc" "$ROOT/svc/repos"
    sudo -n install -o "$SVC_USER" -m 600 "$ROOT/hostkey" "$ROOT/svc/hostkey"
    sudo -n install -o "$SVC_USER" -m 644 "$ROOT/client_key.pub" "$ROOT/svc/authorized_keys"
    cat > "$ROOT/sshd_config.svc" <<CFG
ListenAddress 127.0.0.1
Port $PORT
HostKey $ROOT/svc/hostkey
AuthorizedKeysFile $ROOT/svc/authorized_keys
PidFile $ROOT/svc/sshd.pid
UsePAM no
StrictModes no
PasswordAuthentication no
Subsystem sftp internal-sftp
CFG
    sudo -n install -o "$SVC_USER" -m 644 "$ROOT/sshd_config.svc" "$ROOT/svc/sshd_config"
    # Why: the shared verbs (status, seed guards) recognise a root by this file.
    cp "$ROOT/sshd_config.svc" "$ROOT/sshd_config"
    sudo -n -u "$SVC_USER" /usr/sbin/sshd -f "$ROOT/svc/sshd_config" -E "$ROOT/svc/sshd.log" < /dev/null > /dev/null 2>&1
    sleep 1
    echo "ROOT=$ROOT"
    echo "PORT=$PORT"
    echo "FP=$(ssh-keygen -lf "$ROOT/hostkey.pub" | awk '{print $2}')"
    echo "HOSTNAME=$(hostname)"
    echo "USER=$SVC_USER"
    echo "REPO=$ROOT/svc/repos"
    echo "SEED_NONCE=$(python3 -c "import secrets;print(secrets.token_hex(8))")"
    echo "SSHD_PID=$(sshd_pid)"
    via_private_sshd 'echo HOME_SEEN=$HOME'
    ;;
  seed-svc)
    if [ ! -f "$ROOT/svc/sshd_config" ]; then echo "REFUSED no-svc-root=$ROOT"; exit 3; fi
    case "$EXTRA" in
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
      *) echo "REFUSED nonce=$EXTRA"; exit 2 ;;
    esac
    # Same flags and identity as seed-p16, so the laptop replica shares this root commit (W10).
    sudo -n -u "$SVC_USER" -H bash -s -- "$ROOT/svc/repos/p16-replica" "$EXTRA" "$G" <<'SEED'
set -eu
REPLICA="$1"; NONCE="$2"; G="$3"
if [ -e "$REPLICA" ]; then echo "REFUSED exists=$REPLICA"; exit 3; fi
mkdir -p "$REPLICA"
export GIT_AUTHOR_NAME=hwf16 GIT_AUTHOR_EMAIL=hwf16@example.invalid GIT_AUTHOR_DATE='2026-10-01T00:00:00+0000'
export GIT_COMMITTER_NAME=hwf16 GIT_COMMITTER_EMAIL=hwf16@example.invalid GIT_COMMITTER_DATE='2026-10-01T00:00:00+0000'
$G -C "$REPLICA" init -q
printf 'HWF16_%s\n' "$NONCE" > "$REPLICA/seed.txt"
$G -C "$REPLICA" add seed.txt
$G -C "$REPLICA" commit -q -m 'hwf p16 seed'
echo "SEED_ROOT=$(git -C "$REPLICA" rev-parse HEAD)"
unset GIT_AUTHOR_DATE GIT_COMMITTER_DATE
printf '%s\n' "$(hostname)" > "$REPLICA/host.txt"
$G -C "$REPLICA" add host.txt
$G -C "$REPLICA" commit -q -m 'hwf p16 host commit'
echo "REPLICA_PATH=$REPLICA"
echo "REPLICA_HEAD=$(git -C "$REPLICA" rev-parse HEAD)"
SEED
    ;;
  svc-backup)
    if [ ! -f "$ROOT/svc/sshd_config" ]; then echo "REFUSED no-svc-root=$ROOT"; exit 3; fi
    if sudo -n test -e "$ROOT/svc/backup"; then echo "REFUSED backup-exists"; exit 3; fi
    sudo -n -u "$SVC_USER" bash -s -- "$SVC_HOME" "$ROOT/svc/backup" <<'BACKUP'
set -eu
H="$1"; B="$2"
mkdir -m 700 "$B"
cp -p "$H/.claude/settings.json" "$B/settings.json"
tar -C "$H/.orca" -cf "$B/agent-hooks.tar" agent-hooks
if [ -d "$H/.orca-remote" ]; then echo present > "$B/orca-remote-before"; else echo absent > "$B/orca-remote-before"; fi
BACKUP
    svc_state
    ;;
  svc-state)
    svc_state
    ;;
  svc-restore)
    if ! sudo -n test -f "$ROOT/svc/backup/settings.json"; then echo "REFUSED no-backup"; exit 3; fi
    sudo -n -u "$SVC_USER" bash -s -- "$SVC_HOME" "$ROOT/svc/backup" "$ROOT" <<'RESTORE'
set -eu
H="$1"; B="$2"; R="$3"
# Why not a byte restore: the serve runs Claude as this user and holds its login in the same file.
python3 - "$H/.claude.json" "$R" <<'PY'
import json, os, sys
path, root = sys.argv[1], sys.argv[2].rstrip('/')
with open(path) as f:
    data = json.load(f)
projects = data.get('projects', {})
mine = [k for k in projects if k == root or k.startswith(root + '/')]
for k in mine:
    del projects[k]
if mine:
    tmp = path + '.hwf-restore'
    with open(tmp, 'w') as f:
        json.dump(data, f, indent=2)
    os.chmod(tmp, os.stat(path).st_mode & 0o777)
    os.replace(tmp, path)
print('CLAUDE_JSON_LEG_PROJECTS_REMOVED=%d' % len(mine))
PY
if ! cmp -s "$B/settings.json" "$H/.claude/settings.json"; then
  cp -p "$B/settings.json" "$H/.claude/settings.json.hwf-restore"
  mv "$H/.claude/settings.json.hwf-restore" "$H/.claude/settings.json"
  echo "SETTINGS_RESTORED=yes"
else
  echo "SETTINGS_RESTORED=unchanged"
fi
mkdir -p -m 700 "$B/hooks-now"
tar -C "$H/.orca" -cf "$B/hooks-now/agent-hooks.tar" agent-hooks
if ! cmp -s "$B/agent-hooks.tar" "$B/hooks-now/agent-hooks.tar"; then
  case "$H/.orca/agent-hooks" in /home/orca-svc/.orca/agent-hooks) find "$H/.orca/agent-hooks" -mindepth 1 -delete ;; esac
  tar -C "$H/.orca" -xpf "$B/agent-hooks.tar"
  echo "AGENT_HOOKS_RESTORED=yes"
else
  echo "AGENT_HOOKS_RESTORED=unchanged"
fi
RESTORE
    svc_state
    ;;
  svc-teardown)
    if [ ! -f "$ROOT/svc-pids-before" ]; then echo "REFUSED no-svc-root=$ROOT"; exit 3; fi
    SP=$(sshd_pid)
    NEW=$(svc_new_pids)
    echo "SVC_NEW_PIDS=$(echo $NEW)"
    for P in $NEW $SP; do
      if [ "$P" != 0 ]; then sudo -n kill "$P" 2>/dev/null || true; fi
    done
    I=0
    while [ "$I" -lt 20 ] && [ -n "$(svc_new_pids)" ]; do sleep 0.5; I=$((I + 1)); done
    for P in $(svc_new_pids); do sudo -n kill -KILL "$P" 2>/dev/null || true; done
    sleep 0.5
    LEFT=$(svc_new_pids | wc -l)
    # Only what this leg created in the real home: the transfer's project dir and a fresh relay install.
    ENC=$(printf '%s' "$ROOT/svc/repos/p16-replica" | sed 's/[^A-Za-z0-9]/-/g')
    sudo -n -u "$SVC_USER" bash -s -- "$SVC_HOME" "$ENC" "$ROOT/svc/backup" <<'CLEAN'
H="$1"; ENC="$2"; B="$3"
D="$H/.claude/projects/$ENC"
case "$D" in /home/orca-svc/.claude/projects/-tmp-orca-hwf-p70-*) [ -d "$D" ] && find "$D" -delete && echo "REMOVED_PROJECT_DIR=$ENC" ;; esac
if [ "$(cat "$B/orca-remote-before" 2>/dev/null)" = absent ] && [ -d "$H/.orca-remote" ]; then
  case "$H/.orca-remote" in /home/orca-svc/.orca-remote) find "$H/.orca-remote" -delete && echo "REMOVED_ORCA_REMOTE=yes" ;; esac
fi
true
CLEAN
    ROOT_PROCS=$(sudo -n env ORCA_HWF_ROOT="$ROOT" python3 - <<'PY'
import os
root = os.environ["ORCA_HWF_ROOT"]
# Why from our own parent: sudo, the command substitution and this script all carry the root in argv.
skip = {os.getpid()}
p = os.getppid()
while p > 1:
    skip.add(p)
    try:
        p = int(open("/proc/%d/stat" % p).read().rsplit(")", 1)[1].split()[1])
    except Exception:
        break
n = 0
for d in os.listdir("/proc"):
    if not d.isdigit() or int(d) in skip:
        continue
    try:
        cwd = os.readlink("/proc/%s/cwd" % d)
        argv = open("/proc/%s/cmdline" % d, "rb").read().replace(b"\0", b" ").decode("utf-8", "replace")
    except Exception:
        continue
    if (root in cwd or root in argv) and "ORCA_HWF_ROOT" not in argv:
        n += 1
print(n)
PY
)
    echo "REMAINING=$LEFT"
    echo "PROC_COUNT=$ROOT_PROCS"
    ;;
  *)
    echo "REFUSED verb=$VERB"; exit 2
    ;;
esac
