# Process-tree reaper of the combined-tree gate; sourced by combined-tree-gate.sh (needs $RUN_ID, bash 4).
#
# Why not an env marker alone: Chromium rewrites its own /proc/<pid>/environ, so an Electron main,
# zygote, GPU or renderer shows no CTG_RUN_ID; Playwright starts Electron in a session of its own, and
# under systemd Electron moves its main into an app-*.scope outside the spec's. Each spec therefore runs
# in a systemd user scope (mechanism=scope) or, where that is unavailable, in a session of its own
# (mechanism=pgid). The reap kills the scope, every descendant and every member of any session those
# processes lead, and every process still carrying the marker, then counts what is alive.
# pgid mode learns the spec's descendants by sampling them once a second while the spec runs, so a
# process that is created and detached between two samples can still escape it; scope mode cannot lose one.

REAP_MECHANISM=pgid
declare -A PPID_OF=() SID_OF=() STATE_OF=() START_OF=()
REAP_TREE=()
SPEC_PID=
SPEC_RC=
SPEC_TRACK=

# reap_probe: scope when this host can start a user scope, else pgid.
reap_probe() {
  command -v systemd-run > /dev/null && command -v systemctl > /dev/null &&
    systemd-run --user --scope --collect --quiet --unit="ctg-$RUN_ID-probe" true > /dev/null 2>&1 &&
    REAP_MECHANISM=scope
  return 0
}

# track_spec <spec pid> <file>: appends "<pid> <start time>" of the spec's tree once a second until it exits.
track_spec() {
  local pid
  while kill -0 "$1" 2> /dev/null; do
    spec_tree "$1"
    for pid in ${REAP_TREE[@]+"${REAP_TREE[@]}"}; do
      echo "$pid ${START_OF[$pid]}" >> "$2"
    done
    sleep 1
  done
}

# tracked_pids <file>: the tracked pids still alive as the same process (a recycled pid has a new start time).
tracked_pids() {
  local pid start
  proc_scan
  [ -r "$1" ] || return 0
  while read -r pid start; do
    [ -n "${START_OF[$pid]:-}" ] && [ "${START_OF[$pid]}" = "$start" ] && echo "$pid"
  done < "$1"
  return 0
}

# spec_run <unit> <spec> <log> <cmd...>: runs the spec in its own session (and scope), sets SPEC_PID and SPEC_RC.
spec_run() {
  local unit=$1 spec=$2 log=$3 tracker=
  shift 3
  SPEC_TRACK=${log%.log}.tracked
  if [ "$REAP_MECHANISM" = scope ]; then
    systemd-run --user --scope --collect --quiet --unit="$unit" -- setsid "$@" > "$log" 2>&1 &
  else
    setsid "$@" > "$log" 2>&1 &
  fi
  SPEC_PID=$!
  if [ "$REAP_MECHANISM" = pgid ]; then
    track_spec "$SPEC_PID" "$SPEC_TRACK" &
    tracker=$!
  fi
  # Why a trap: the spec is no longer in the runner's session, so an interrupt would leave it running.
  trap 'reap_spec "$spec" "$unit" "$SPEC_PID" > /dev/null; exit 143' INT TERM HUP
  wait "$SPEC_PID"
  SPEC_RC=$?
  trap - INT TERM HUP
  [ -z "$tracker" ] || kill "$tracker" 2> /dev/null
  return 0
}

# proc_scan: PPID_OF, SID_OF, STATE_OF and START_OF for every process, read without forking.
proc_scan() {
  local dir pid line state
  PPID_OF=() SID_OF=() STATE_OF=() START_OF=()
  for dir in /proc/[0-9]*; do
    pid=${dir#/proc/}
    { read -r line < "$dir/stat"; } 2> /dev/null || continue
    read -r state "PPID_OF[$pid]" _ "SID_OF[$pid]" _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ "START_OF[$pid]" _ <<< "${line##*) }"
    STATE_OF[$pid]=$state
  done
}

# is_protected <pid>: the runner, its ancestors and its own session are never reaped.
is_protected() {
  [ "$1" = "$$" ] || [ "${SID_OF[$1]:-}" = "${SID_OF[$$]:-0}" ] || [ -n "${safe[$1]:-}" ]
}

# spec_tree <pid>...: sets REAP_TREE to each live seed, every descendant, every member of a session a seed
# or a member leads, and the leader of every member's session.
spec_tree() {
  local -A keep=() sessions=() safe=()
  local pid seed lead up=$$ changed=1
  proc_scan
  while [ -n "${PPID_OF[$up]:-}" ] && [ "$up" != 0 ]; do
    safe[$up]=1
    up=${PPID_OF[$up]}
  done
  for seed in "$@"; do
    sessions[$seed]=1
    [ -n "${PPID_OF[$seed]:-}" ] && ! is_protected "$seed" && keep[$seed]=1
  done
  while [ "$changed" = 1 ]; do
    changed=0
    for pid in "${!PPID_OF[@]}"; do
      is_protected "$pid" && continue
      if [ -n "${keep[$pid]:-}" ]; then
        lead=${SID_OF[$pid]}
        if [ -n "${PPID_OF[$lead]:-}" ] && [ -z "${keep[$lead]:-}" ] && ! is_protected "$lead"; then
          keep[$lead]=1
          changed=1
        fi
      elif [ -n "${keep[${PPID_OF[$pid]}]:-}" ] || [ -n "${sessions[${SID_OF[$pid]}]:-}" ] ||
        [ -n "${keep[${SID_OF[$pid]}]:-}" ]; then
        keep[$pid]=1
        changed=1
      fi
    done
  done
  REAP_TREE=("${!keep[@]}")
}

# marked_pids: the processes that still show this run's CTG_RUN_ID (Chromium's own do not).
marked_pids() {
  local dir pid
  for dir in /proc/[0-9]*; do
    pid=${dir#/proc/}
    [ "$pid" = "$$" ] && continue
    grep -qFazx "CTG_RUN_ID=$RUN_ID" "$dir/environ" 2> /dev/null && echo "$pid"
  done
}

# scope_pids <unit>: the pids of the unit's cgroup, none when the scope is already gone.
scope_pids() {
  local cg
  cg=$(systemctl --user show --property=ControlGroup --value "$1.scope" 2> /dev/null)
  [ -n "$cg" ] && [ -r "/sys/fs/cgroup$cg/cgroup.procs" ] && cat "/sys/fs/cgroup$cg/cgroup.procs"
  return 0
}

# live_count: how many of REAP_TREE are running (a zombie waiting for its reaper is gone).
live_count() {
  local pid n=0
  for pid in ${REAP_TREE[@]+"${REAP_TREE[@]}"}; do
    [ -n "${STATE_OF[$pid]:-}" ] && [ "${STATE_OF[$pid]}" != Z ] && n=$((n + 1))
  done
  echo "$n"
}

# reap_extra <unit>: what the marker, the scope and the tracker still name, one pid per line.
reap_extra() {
  marked_pids
  [ "$REAP_MECHANISM" = scope ] && scope_pids "$1"
  tracked_pids "$SPEC_TRACK"
  return 0
}

# reap_spec <spec> <unit> <spec pid>: SIGKILLs the spec's whole tree and mints its REAP line.
reap_spec() {
  local spec=$1 unit=$2 pid tries
  local -a extra victims
  mapfile -t extra < <(reap_extra "$unit")
  spec_tree "$3" ${extra[@]+"${extra[@]}"}
  victims=(${REAP_TREE[@]+"${REAP_TREE[@]}"})
  # Why the rc is ignored: systemctl kill reports EINVAL for the scope's absent auxiliary processes.
  [ "$REAP_MECHANISM" = scope ] && systemctl --user kill --signal=SIGKILL "$unit.scope" > /dev/null 2>&1
  for pid in ${victims[@]+"${victims[@]}"}; do
    kill -KILL "$pid" 2> /dev/null
  done
  for tries in 1 2 3 4 5 6 7 8 9 10; do
    spec_tree ${victims[@]+"${victims[@]}"}
    [ "$(live_count)" = 0 ] && break
    sleep 0.2
  done
  [ "$REAP_MECHANISM" = scope ] && systemctl --user stop "$unit.scope" > /dev/null 2>&1
  mapfile -t extra < <(reap_extra "$unit")
  spec_tree ${victims[@]+"${victims[@]}"} ${extra[@]+"${extra[@]}"}
  node "$CONTRACT" reap-result --name "$spec" --mechanism "$REAP_MECHANISM" --survivors "$(live_count)" 2>&1 |
    tee -a "$S"
  return 0
}
