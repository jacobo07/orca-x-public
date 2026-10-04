#!/usr/bin/env bash
# Runs one command against a REAL full-able filesystem: an 8 MB ext4 image attached to a loop device and
# mounted with sudo (or a 4 MB tmpfs with --fs tmpfs), so a test can fill it and read the kernel's own ENOSPC.
# The command runs with ORCA_ENOSPC_VOLUME=<mountpoint>; the volume is released whatever happens.
#
# Linux only, and only where `sudo -n` works: the mount is a host-wide state change, so every step is scoped to
# the run directory this script creates itself and to the one loop device it was handed. No host path is written
# here; the caller passes every location.
#
# Usage:
#   real-enospc-volume.sh --run-dir <abs dir> [--fs ext4|tmpfs] [--size-mb N] -- <command...>
#   real-enospc-volume.sh --recover --run-dir <abs dir>
# --run-dir: absolute, parent an existing real directory owned by the caller, basename starting with `p3-enospc-`,
#   the path must NOT exist yet (this script creates it with a marker before anything else), never under /tmp.
#   Only <run-dir>/volume.img and <run-dir>/mnt are ever created, mounted over, chowned or removed (no rm -rf).
# --recover: for a driver killed without its trap. Releases only the device recorded in <run-dir>/loop-device.txt,
#   only after `sudo -n losetup -j <run-dir>/volume.img` names it, and only for a run dir this script could have made:
#   a real (non-symlink) directory owned by the caller with mode 0700, holding the v1 nonce marker, with mnt,
#   volume.img, loop-device.txt and the marker all non-symlinks. Never runs `losetup -f`, never mounts.
# Tools: losetup and mkfs.ext4 are NOT on an ordinary user's PATH; they are resolved from REAL_ENOSPC_SBIN_DIRS
# below (never from the environment) and called by absolute path. Every loop probe goes through `sudo -n` because
# an unprivileged `losetup -j` can read a live loop device as absent.
#
# Output: one line per step on stdout and in <run-dir>/volume.log: TOOL, VOLUME, COMMAND_EXIT, LEFTOVER_PROBE_PRE
# (read while still mounted: proves the leftover instrument sees a live mount), and a final
# `LEFTOVER mount=<0|1> loop=<0|1> device=<dev>`. Unknown is never read as absent: a failed loop probe counts as 1.
#
# Exit: 0 ok | 1 the command failed | 2 usage or refused argument | 3 precondition missing or BLOCKED_EXTERNAL |
#       4 mountpoint already mounted (nothing touched) | 5 a mount or loop device is left | 6 leftover instrument blind.
set -u -o pipefail

REAL_ENOSPC_SBIN_DIRS='/usr/sbin /sbin'

CAP_MB=64
RUN_DIR=''
FS=ext4
SIZE_MB=''
RECOVER=0
CMD=()
LOSETUP=''
MKFS_EXT4=''
DEV=''
MOUNTED=0
BLIND=0
MARKER_LINE=''
IMG=''
MNT=''
MARKER=''
LOGFILE=''
CMD_RC=0

log() {
  printf '%s\n' "$*"
  if [ -n "$LOGFILE" ] && [ -d "$RUN_DIR" ]; then
    printf '%s\n' "$*" >> "$LOGFILE"
  fi
}

refuse() {
  local code=$1
  shift
  log "$*"
  exit "$code"
}

usage() {
  refuse 2 "USAGE real-enospc-volume.sh --run-dir <abs dir> [--fs ext4|tmpfs] [--size-mb N] -- <command...> | --recover --run-dir <abs dir>"
}

# check_run_dir_name: the path rules shared by a run and a recovery.
check_run_dir_name() {
  case "$RUN_DIR" in
    /*) ;;
    *) refuse 2 "REFUSED run-dir-absolute $RUN_DIR" ;;
  esac
  case "$RUN_DIR/" in
    */../* | */./* | *//*) refuse 2 "REFUSED run-dir-path $RUN_DIR" ;;
  esac
  case "$RUN_DIR" in
    /tmp | /tmp/* | /var/tmp | /var/tmp/*) refuse 2 "REFUSED run-dir-tmp $RUN_DIR" ;;
  esac
  case "$(basename -- "$RUN_DIR")" in
    p3-enospc-?*) ;;
    *) refuse 2 "REFUSED run-dir-prefix $RUN_DIR" ;;
  esac
}

set_paths() {
  IMG=$RUN_DIR/volume.img
  MNT=$RUN_DIR/mnt
  MARKER=$RUN_DIR/.real-enospc-volume.marker
  LOGFILE=$RUN_DIR/volume.log
}

resolve_tools() {
  local d
  for d in $REAL_ENOSPC_SBIN_DIRS; do
    [ -z "$LOSETUP" ] && [ -x "$d/losetup" ] && LOSETUP=$d/losetup
    [ -z "$MKFS_EXT4" ] && [ -x "$d/mkfs.ext4" ] && MKFS_EXT4=$d/mkfs.ext4
  done
}

marker_ok() {
  [ -f "$MARKER" ] && [ ! -L "$MARKER" ] && [ "$(cat -- "$MARKER" 2> /dev/null)" = "$MARKER_LINE" ]
}

# probe_mount: 1 when this run's mountpoint (or its device) shows up as mounted.
probe_mount() {
  if mountpoint -q -- "$MNT" 2> /dev/null; then
    echo 1
    return
  fi
  if [ -n "$DEV" ] && [ "$DEV" != tmpfs ] && [ -n "$(findmnt -rn -S "$DEV" 2> /dev/null)" ]; then
    echo 1
    return
  fi
  echo 0
}

# probe_loop: 1 when the image is backed by a loop device or the probe cannot tell (unknown is not absent).
probe_loop() {
  local answer rc
  if [ "$FS" = tmpfs ] || [ ! -e "$IMG" ]; then
    echo 0
    return
  fi
  answer=$(sudo -n "$LOSETUP" -j "$IMG" 2> /dev/null)
  rc=$?
  if [ "$rc" != 0 ]; then
    log "LOOP_PROBE_FAILED rc=$rc" >&2
    echo 1
  elif [ -n "$answer" ]; then
    echo 1
  else
    echo 0
  fi
}

# unmount_own: unmount <run-dir>/mnt only when its source is the expected device. A busy unmount is reported, never forced.
unmount_own() {
  local want=$1 src
  if mountpoint -q -- "$MNT" 2> /dev/null; then
    src=$(findmnt -rn -M "$MNT" -o SOURCE 2> /dev/null)
    if [ "$src" = "$want" ] && marker_ok; then
      if sudo -n umount -- "$MNT"; then
        log "UMOUNT ok mnt=$MNT"
      else
        log "UMOUNT_FAILED mnt=$MNT (busy or refused; not forced)"
      fi
    else
      log "UMOUNT_SKIPPED source=$src want=$want"
    fi
  fi
}

# image_names_device: 0 only when `sudo -n losetup -j <image>` succeeds and lists $DEV; an unreadable probe is "no".
image_names_device() {
  local answer
  answer=$(sudo -n "$LOSETUP" -j "$IMG" 2> /dev/null) || return 1
  printf '%s\n' "$answer" | grep -q "^$DEV:"
}

# detach_own: detach the recorded device, only after `losetup -j <image>` names it and nothing is mounted from it.
detach_own() {
  local answer rc
  [ -n "$DEV" ] && [ "$DEV" != tmpfs ] && [ -e "$IMG" ] || return 0
  if [ "$(probe_mount)" = 1 ]; then
    log "DETACH_SKIPPED still-mounted dev=$DEV"
    return 0
  fi
  answer=$(sudo -n "$LOSETUP" -j "$IMG" 2> /dev/null)
  rc=$?
  if [ "$rc" != 0 ]; then
    log "DETACH_SKIPPED probe-failed rc=$rc dev=$DEV"
  elif printf '%s\n' "$answer" | grep -q "^$DEV:"; then
    if marker_ok && sudo -n "$LOSETUP" -d "$DEV"; then
      log "DETACH ok dev=$DEV"
    else
      log "DETACH_FAILED dev=$DEV"
    fi
  elif [ -n "$answer" ]; then
    log "RECOVER_REFUSED owner-mismatch dev=$DEV j=$answer"
  fi
  return 0
}

# final_probe: the closing LEFTOVER line; removes only the image and the mountpoint, and only when both probes read 0.
final_probe() {
  local m l
  m=$(probe_mount)
  l=$(probe_loop)
  log "LEFTOVER mount=$m loop=$l device=${DEV:-none}"
  if [ "$m" = 0 ] && [ "$l" = 0 ] && marker_ok; then
    if [ -f "$IMG" ] && [ ! -L "$IMG" ]; then
      rm -f -- "$IMG"
    fi
    if [ -d "$MNT" ] && [ ! -L "$MNT" ]; then
      rmdir -- "$MNT" 2> /dev/null || log "MNT_REMOVE_FAILED $MNT"
    fi
    return 0
  fi
  return 5
}

release_volume() {
  local mount_pre loop_pre expected_loop=1 want=$DEV
  if [ "$MOUNTED" = 1 ]; then
    mount_pre=$(probe_mount)
    loop_pre=$(probe_loop)
    [ "$FS" = tmpfs ] && expected_loop=0
    log "LEFTOVER_PROBE_PRE mount=$mount_pre loop=$loop_pre"
    if [ "$mount_pre" != 1 ] || [ "$loop_pre" != "$expected_loop" ]; then
      BLIND=1
      log "LEFTOVER_INSTRUMENT_BLIND expected mount=1 loop=$expected_loop"
    fi
    [ "$FS" = tmpfs ] && want=tmpfs
    unmount_own "$want"
  fi
  detach_own
  final_probe
  local rc=$?
  if [ "$rc" != 0 ]; then
    return 5
  fi
  [ "$BLIND" = 1 ] && return 6
  return 0
}

on_exit() {
  local rc=$? rel
  trap - EXIT
  release_volume
  rel=$?
  [ "$rel" != 0 ] && exit "$rel"
  exit "$rc"
}

# check_recover_ownership: refuse a run dir this script could not have made, and pin RUN_DIR to its physical path so
# mountpoint, findmnt, umount and losetup all see the same real names.
check_recover_ownership() {
  local me item
  me=$(id -u)
  if [ "$(stat -c %u -- "$RUN_DIR" 2> /dev/null)" != "$me" ] || [ "$(stat -c %a -- "$RUN_DIR" 2> /dev/null)" != 700 ]; then
    refuse 2 "RECOVER_REFUSED not-owned $RUN_DIR (must be owned by the caller with mode 0700)"
  fi
  for item in "$MNT" "$IMG" "$RUN_DIR/loop-device.txt" "$MARKER"; do
    if [ -L "$item" ]; then
      refuse 2 "RECOVER_REFUSED symlink $item"
    fi
  done
  if [ -e "$MARKER" ] && [ "$(stat -c %u -- "$MARKER" 2> /dev/null)" != "$me" ]; then
    refuse 2 "RECOVER_REFUSED not-owned $MARKER"
  fi
  RUN_DIR=$(cd -P -- "$RUN_DIR" 2> /dev/null && pwd -P) || refuse 2 "RECOVER_REFUSED no-marker (unresolvable) $RUN_DIR"
  check_run_dir_name
  set_paths
}

run_recover() {
  local recorded mount_before loop_before answer
  check_run_dir_name
  set_paths
  [ -d "$RUN_DIR" ] && [ ! -L "$RUN_DIR" ] || refuse 2 "RECOVER_REFUSED no-marker (no such directory) $RUN_DIR"
  [ -f "$MARKER" ] && [ ! -L "$MARKER" ] || refuse 2 "RECOVER_REFUSED no-marker $RUN_DIR"
  MARKER_LINE=$(cat -- "$MARKER")
  printf '%s\n' "$MARKER_LINE" | grep -Eq '^real-enospc-volume marker v1 pid=[0-9]+ nonce=[0-9a-f]+$' \
    || refuse 2 "RECOVER_REFUSED no-marker (not a v1 marker) $RUN_DIR"
  # Why: the marker is read from the file it is later compared with, so it proves a format, not authorship. Authorship
  # is the owner and 0700 of the directory the driver creates, plus no link anywhere a probe or umount would follow.
  check_recover_ownership
  [ -f "$RUN_DIR/loop-device.txt" ] || refuse 2 "RECOVER_REFUSED no-device-record $RUN_DIR"
  recorded=$(cat -- "$RUN_DIR/loop-device.txt")
  printf '%s\n' "$recorded" | grep -Eq '^(/dev/loop[0-9]+|tmpfs)$' || refuse 2 "RECOVER_REFUSED bad-device-record $recorded"
  command -v sudo > /dev/null || refuse 3 "PRECONDITION_MISSING sudo"
  resolve_tools
  if [ "$recorded" != tmpfs ] && [ -z "$LOSETUP" ]; then
    refuse 3 "PRECONDITION_MISSING losetup"
  fi
  DEV=$recorded
  [ "$recorded" = tmpfs ] && FS=tmpfs
  mount_before=$(probe_mount)
  loop_before=$(probe_loop)
  log "TOOL losetup=${LOSETUP:-none} mkfs.ext4=${MKFS_EXT4:-none}"
  log "RECOVER dev=$recorded mount_before=$mount_before loop_before=$loop_before"
  if [ "$mount_before" = 1 ]; then
    # Why: a mount of the recorded device is released only when losetup -j names it for this run's own image.
    if [ "$recorded" = tmpfs ] || image_names_device; then
      unmount_own "$([ "$recorded" = tmpfs ] && echo tmpfs || echo "$recorded")"
    else
      log "UMOUNT_SKIPPED image-does-not-name dev=$recorded"
    fi
  fi
  detach_own
  final_probe
  if [ $? = 0 ]; then
    exit 0
  fi
  exit 5
}

while [ $# -gt 0 ]; do
  case "$1" in
    --run-dir)
      [ $# -ge 2 ] || usage
      RUN_DIR=$2
      shift 2
      ;;
    --fs)
      [ $# -ge 2 ] || usage
      FS=$2
      shift 2
      ;;
    --size-mb)
      [ $# -ge 2 ] || usage
      SIZE_MB=$2
      shift 2
      ;;
    --recover)
      RECOVER=1
      shift
      ;;
    --)
      shift
      CMD=("$@")
      break
      ;;
    *) usage ;;
  esac
done

[ -n "$RUN_DIR" ] || usage
if [ "$RECOVER" = 1 ]; then
  run_recover
fi
[ "${#CMD[@]}" -gt 0 ] || usage
case "$FS" in
  ext4) : "${SIZE_MB:=8}" ;;
  tmpfs) : "${SIZE_MB:=4}" ;;
  *) refuse 2 "REFUSED fs $FS (ext4 or tmpfs)" ;;
esac
case "$SIZE_MB" in
  '' | *[!0-9]* | 0 | 0[0-9]*) refuse 2 "REFUSED size-mb $SIZE_MB (positive integer)" ;;
esac
[ "$SIZE_MB" -le "$CAP_MB" ] || refuse 2 "REFUSED size-mb $SIZE_MB exceeds the $CAP_MB MB cap"
[ "$FS" = ext4 ] || [ "$SIZE_MB" -le 4 ] || refuse 2 "REFUSED size-mb $SIZE_MB (tmpfs fallback is at most 4 MB)"

check_run_dir_name
set_paths
if [ -e "$RUN_DIR" ] || [ -L "$RUN_DIR" ]; then
  refuse 2 "REFUSED run-dir-exists $RUN_DIR"
fi
PARENT=$(dirname -- "$RUN_DIR")
if [ -L "$PARENT" ] || [ ! -d "$PARENT" ] || [ "$(stat -c %u -- "$PARENT" 2> /dev/null)" != "$(id -u)" ]; then
  refuse 2 "REFUSED run-dir-parent $PARENT (must be an existing real directory owned by the caller)"
fi

[ "$(uname -s)" = Linux ] || refuse 3 "PRECONDITION_MISSING linux"
sudo -n true > /dev/null 2>&1 || refuse 3 "BLOCKED_EXTERNAL needs a bounded filesystem (root mount or CAP_SYS_ADMIN)"
resolve_tools
if [ "$FS" = ext4 ]; then
  [ -n "$LOSETUP" ] || refuse 3 "PRECONDITION_MISSING losetup"
  [ -n "$MKFS_EXT4" ] || refuse 3 "PRECONDITION_MISSING mkfs.ext4"
fi

# The marker is the first thing created: from here on every step re-reads it.
NONCE=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
MARKER_LINE="real-enospc-volume marker v1 pid=$$ nonce=$NONCE"
mkdir -m 0700 -- "$RUN_DIR" || refuse 2 "REFUSED run-dir-exists $RUN_DIR (lost the creation race)"
printf '%s\n' "$MARKER_LINE" > "$MARKER"
log "TOOL losetup=${LOSETUP:-none} mkfs.ext4=${MKFS_EXT4:-none}"
log "RUN_DIR $RUN_DIR fs=$FS size_mb=$SIZE_MB"

marker_ok || refuse 3 "MARKER_MISMATCH before mnt"
mkdir -m 0700 -- "$MNT"
if mountpoint -q -- "$MNT"; then
  refuse 4 "ALREADY_MOUNTED $MNT (nothing mounted or unmounted)"
fi

trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$FS" = ext4 ]; then
  marker_ok || exit 3
  truncate -s "${SIZE_MB}M" -- "$IMG" || refuse 3 "PRECONDITION_MISSING image-create"
  "$MKFS_EXT4" -q -F "$IMG" > /dev/null 2>&1 || refuse 3 "PRECONDITION_MISSING mkfs-failed"
  marker_ok || exit 3
  attached=$(sudo -n "$LOSETUP" -f --show "$IMG")
  if ! printf '%s\n' "$attached" | grep -Eq '^/dev/loop[0-9]+$'; then
    # A device may be attached but unrecorded: detach only what the image's own probe names.
    named=$(sudo -n "$LOSETUP" -j "$IMG" 2> /dev/null | head -n 1 | cut -d: -f1)
    if printf '%s\n' "$named" | grep -Eq '^/dev/loop[0-9]+$' && sudo -n "$LOSETUP" -d "$named"; then
      log "DEVICE_UNRECORDED recovered=$named"
    else
      log "DEVICE_UNRECORDED recovered=none"
    fi
    exit 3
  fi
  DEV=$attached
  printf '%s\n' "$DEV" > "$RUN_DIR/loop-device.txt"
  log "LOOP_DEVICE $DEV image=$IMG"
  marker_ok || exit 3
  sudo -n mount -t ext4 "$DEV" "$MNT" || refuse 3 "PRECONDITION_MISSING mount-failed dev=$DEV"
else
  DEV=tmpfs
  printf '%s\n' tmpfs > "$RUN_DIR/loop-device.txt"
  marker_ok || exit 3
  sudo -n mount -t tmpfs -o "size=${SIZE_MB}m,mode=0700,uid=$(id -u),gid=$(id -g)" tmpfs "$MNT" \
    || refuse 3 "PRECONDITION_MISSING mount-failed fs=tmpfs"
fi
MOUNTED=1
marker_ok || exit 3
sudo -n chown "$(id -u):$(id -g)" -- "$MNT" || refuse 3 "PRECONDITION_MISSING chown-failed"
blocks=$(stat -f -c '%b' -- "$MNT")
frag=$(stat -f -c '%S' -- "$MNT")
bytes=$((blocks * frag))
log "VOLUME fs=$FS dev=$DEV mnt=$MNT bytes=$bytes"
if [ "$bytes" -gt $((SIZE_MB * 1024 * 1024)) ]; then
  refuse 3 "PRECONDITION_MISSING volume-too-large bytes=$bytes cap=$((SIZE_MB * 1024 * 1024))"
fi

START=$SECONDS
ORCA_ENOSPC_VOLUME=$MNT "${CMD[@]}"
CMD_RC=$?
log "COMMAND_EXIT $CMD_RC seconds=$((SECONDS - START))"
[ "$CMD_RC" = 0 ] || exit 1
exit 0
