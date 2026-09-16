---
covers: [resource-elasticity, resource-census, terminal-host-attribution, density-lab, observation-budget, stream-taxonomy, pressure-model, resource-governor]
status: active
---

# Resource Elasticity Fabric

Orca should be able to remember far more logical work than it keeps resident. This spec is the
composition layer over owners that already exist. It is not a new subsystem. Wave numbering is
from the 2026-09-16 program plan.

## Owners this spec composes, and does not replace

| Concern | Canonical owner |
|---|---|
| Presentation eviction | cold parking (`terminal-hidden-view-parking.ts`), force-park retention (`terminal-hidden-worktree-retention.ts`), hidden WebGL LRU (`terminal-webgl-hidden-retention.ts`) |
| Terminal output bounds | main pending/in-flight windows and producer flow control (`src/main/ipc/pty.ts`), daemon batcher and keep-tail (`src/main/daemon/daemon-stream-*`), renderer scheduler (`pane-terminal-output-scheduler.ts`) |
| Destructive reclaim | the agent hibernation coordinator and its authorization plan; the governor only ever requests |
| Dormant composition | the project working-set program (W1–W6) |
| Resource census | `src/main/memory/collector.ts` |

## Invariants

1. Unknown is never zero. A census that could not observe says so.
2. Orca-owned processes are attributed, including the ones that are not Electron children.
3. Workload memory (user shells, agents, dev servers) is never reported as Orca overhead, and
   memory whose owner cannot be named is reported as unattributed rather than assigned.
4. An observation never authorizes destruction. A pid learned from the daemon hello is used for
   attribution only, and only while its authenticated connection is open.
5. Cost should scale with the active set, not the remembered set; exceptions are declared.

## R1 — the terminal host is counted, and a failed sweep is not zero

The daemon is a detached `fork` (`daemon-init.ts`), so `app.getAppMetrics()` never lists it, and
before R1 the collector walked only registered PTY subtrees. On Windows the ConPTY host processes are
children of the daemon, not of the shell, so they were invisible too.

Acceptance:
- The snapshot carries the connected daemon process's own usage as a terminal-host bucket, included
  in the Orca app total.
- The daemon's descendants not claimed by any registered PTY are reported separately as
  unattributed, in the snapshot total but not in the Orca total.
- Registered PTY subtrees are claimed first, so no pid is counted twice.
- A daemon pid is used only from a connected adapter; a disconnected adapter contributes nothing.
- A sweep that returned no process rows is marked failed, and consumers can tell it apart from a
  measured idle host.
- All new snapshot fields are optional, so older remote peers stay compatible.
- Red first: a test that fails on the pre-R1 collector; a mutation that drops the daemon walk
  fails it.

Out of scope for R1: the overhead/workload split in the UI copy (R2) and remote hosts (each host
reports its own truth).
