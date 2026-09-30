#!/bin/sh
# Independent control reading for the one-node manifest. Read-only: it only prints resource facts.
# Usage: sh dws-node-manifest-ssh-control.sh [model-probe-port]
# Every command is a plain top-level line so a local command rewriter cannot hide inside a nested shell;
# the first output line must be CONTROL_BEGIN, otherwise the parser reports harness-rewrote-command.
echo CONTROL_BEGIN
date -u +%Y-%m-%dT%H:%M:%SZ
echo CONTROL_FREE
free -b
echo CONTROL_NVIDIA
nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free --format=csv,noheader,nounits
echo CONTROL_DF
df -B1 /
echo CONTROL_MODELS
curl -s -m 3 http://127.0.0.1:$1/v1/models
echo CONTROL_SS
ss -Hltn
