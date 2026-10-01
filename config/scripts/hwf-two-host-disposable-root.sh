#!/usr/bin/env bash
# GEX44 provisioner for the phase-15 two-host rung; verbs: create status witness procs teardown. Never deletes anything.
set -eu

VERB="${1:-}"
ROOT="${2:-}"

case "$ROOT" in
  /tmp/orca-hwf-p15-) echo "REFUSED root=$ROOT"; exit 2 ;;
  /tmp/orca-hwf-p15-*[!0-9A-Za-z]*) echo "REFUSED root=$ROOT"; exit 2 ;;
  /tmp/orca-hwf-p15-*) ;;
  *) echo "REFUSED root=$ROOT"; exit 2 ;;
esac

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
  if [ -f "$ROOT/sshd.pid" ]; then cat "$ROOT/sshd.pid"; else echo 0; fi
}

via_private_sshd() {
  ssh -n -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile="$ROOT/kh_probe" \
    -o IdentitiesOnly=yes -i "$ROOT/client_key" -p "$(cat "$ROOT/port")" "$USER_NAME@127.0.0.1" "$1"
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
  *)
    echo "REFUSED verb=$VERB"; exit 2
    ;;
esac
