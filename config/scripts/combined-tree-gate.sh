#!/usr/bin/env bash
# Combined-tree gate: judges a combined-tree run against config/combined-tree-gate.jsonc by name and
# count. The verdict lives in combined-tree-gate-contract.mjs; this script only orchestrates.
#
# Linux test plane only (GEX44); run and dry-run refuse elsewhere.
#
# Usage:
#   combined-tree-gate.sh --verdict-only <summary.txt> [--manifest <path>]
#
# Env contract (no host path is written in this file):
#   CTG_TOOLCHAIN_BIN  optional; prepended to PATH so `node` is the toolchain node.
#
# Exit: 0 GREEN, 1 RED, 2 NO_VERDICT, 90 tree, 91 HEAD mismatch, 92 dirty, 93 run dir exists,
#       94 lock, 95 busy, 96 env/toolchain/platform, 97 manifest, 99 HEAD moved.
set -u

TREE=$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null) || {
  echo "REFUSED_TREE $(dirname "$0") is not inside a git work tree"
  exit 90
}
CONTRACT=$TREE/config/scripts/combined-tree-gate-contract.mjs
MANIFEST=$TREE/config/combined-tree-gate.jsonc
[ -n "${CTG_TOOLCHAIN_BIN:-}" ] && export PATH="$CTG_TOOLCHAIN_BIN:$PATH"

# ctg_verdict <summary>: prints the contract's verdict; returns 0/1/2.
# Why the line check: an entry guard that never fires exits 0 having printed nothing.
ctg_verdict() {
  local out rc n last
  out=$(node "$CONTRACT" verdict --manifest "$MANIFEST" --summary "$1" 2>&1)
  rc=$?
  printf '%s\n' "$out"
  n=$(printf '%s\n' "$out" | grep -c '^TIP_VERDICT ')
  last=$(printf '%s\n' "$out" | tail -n 1)
  if [ "$n" != 1 ]; then
    echo "TIP_VERDICT NO_VERDICT contract printed $n verdict lines"
    return 2
  fi
  case "$rc:$last" in
    "0:TIP_VERDICT GREEN "* | "1:TIP_VERDICT RED "* | "2:TIP_VERDICT NO_VERDICT "*) return "$rc" ;;
  esac
  echo "TIP_VERDICT NO_VERDICT contract exit=$rc disagrees with its last line"
  return 2
}

MODE=
SUMMARY=
while [ $# -gt 0 ]; do
  case "$1" in
    --verdict-only)
      MODE=verdict-only
      SUMMARY=${2:-}
      shift 2 || shift
      ;;
    --manifest)
      MANIFEST=${2:-}
      shift 2 || shift
      ;;
    *)
      echo "REFUSED_USAGE unknown argument: $1"
      exit 2
      ;;
  esac
done

case "$MODE" in
  verdict-only)
    [ -n "$SUMMARY" ] || { echo "TIP_VERDICT NO_VERDICT --verdict-only needs a summary path"; exit 2; }
    ctg_verdict "$SUMMARY"
    exit $?
    ;;
  *)
    echo "usage: combined-tree-gate.sh --verdict-only <summary.txt> [--manifest <path>]"
    exit 2
    ;;
esac
