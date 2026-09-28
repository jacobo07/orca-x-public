#!/usr/bin/env bash
# Reaps one AEOS remote run, and nothing else on a shared host.
#
#   aeos-remote-run-abort.sh <runDir>
#
# GEX44 hosts other tenants (ComfyUI, kobii-hive, sentinel, Postgres). There is
# no kill-by-name here and there never may be: the target set is derived from
# the SESSION the run recorded in its own manifest, so a process this mission
# did not start cannot be in it.
#
# Two traps this cost when it was done by hand on 2026-09-22, both silent:
#
#   1. A run owns a SESSION, not a process group. vitest's worker pool lands in
#      a second pgid, so `kill -TERM -$pgid` against the manifest's pgid reaped
#      the wrapper shell and left all 12 workers running -- while reporting
#      nothing. Enumerate every pgid in the session.
#   2. `GROUPS` is a readonly bash array holding the caller's group ids.
#      Assigning to it is silently ignored, so the loop expanded to `1000` and
#      signalled a group that was never ours. Never name a variable GROUPS.
set -u

RUN_DIR="${1:-}"
[ -n "$RUN_DIR" ] || { echo "usage: aeos-remote-run-abort.sh <runDir>" >&2; exit 2; }
[ -f "$RUN_DIR/run.json" ] || { echo "no manifest in $RUN_DIR; refusing to signal anything" >&2; exit 2; }

PID="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['pid'])" "$RUN_DIR/run.json")"
SID="$(ps -o sid= -p "$PID" 2>/dev/null | tr -d ' ')"
if [ -z "$SID" ]; then
  echo "run $PID is already gone; nothing to reap"
  exit 0
fi
# A session id at or below 1 would mean init. Refuse rather than guess.
if [ "$SID" -le 1 ]; then echo "implausible session $SID; refusing" >&2; exit 3; fi

RUN_PGIDS="$(ps -eo pgid=,sid= | awk -v s="$SID" '$2==s {print $1}' | sort -u)"
echo "run pid=$PID session=$SID groups=$(echo "$RUN_PGIDS" | tr '\n' ' ')"

signal_all() {
  for gid in $RUN_PGIDS; do
    [ "$gid" -gt 1 ] && kill -"$1" -"$gid" 2>/dev/null
  done
  return 0
}
signal_all TERM
sleep "${AEOS_ABORT_GRACE_SECONDS:-6}"
signal_all KILL
sleep 2

SURVIVORS="$(ps -eo pid,pgid,sid,comm | awk -v s="$SID" '$3==s')"
if [ -n "$SURVIVORS" ]; then
  echo "SESSION NOT EMPTY:"
  echo "$SURVIVORS"
  exit 1
fi
echo "session $SID fully reaped"
