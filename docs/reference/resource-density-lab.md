---
covers: [density-lab, resource-density, resource-complexity, benchmark-provenance]
status: active
---

# Resource Density Lab (R3)

How Orca's cost is measured as work scales. R3 of [the Resource Elasticity Fabric](./resource-elasticity-fabric.md),
which holds the invariants this protocol serves — above all "unknown is never zero" and "workload
memory is never reported as Orca overhead".

This is a measurement protocol, not a subsystem. It composes owners that already exist: the census
(`src/main/memory/collector.ts`), the cardinality rigs named below, and the memory e2e specs
(`tests/e2e/terminal-parked-memory.spec.ts`, `tests/e2e/resource-usage-warm-reattach.spec.ts`), which
are the estate's byte and cell instruments. New scenarios extend those; they do not fork them.

`config/scripts/run-terminal-scale-perf-e2e.mjs` is a **latency** lab — frame counts at 10/25/50/100
panes. It instruments no memory at all, so it is an owner for time at scale and never for a byte
curve. Two waves of this program cited it as one; it is not.

## The six dimensions, kept apart

A single "panes" axis cannot answer where cost lives, because one logical row, one rendered row and
one live process are different resources.

| Dimension            | Scale variable                               | Owner of the state                                                  |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| Logical session      | remembered rows, no runtime                  | project working-set program; dormancy marker in `terminals.ts`      |
| Presentation         | rows actually mounted                        | mount decision + hidden retention/parking owners                    |
| Terminal runtime     | live PTYs                                    | `src/main/ipc/pty.ts`, daemon terminal host                         |
| Agent runtime        | live managed agents                          | agent-completion coordinator and the process-exit backstop          |
| Repository           | observed worktrees                           | `src/main/ipc/worktree-observation-clock.ts`                        |
| Window               | Orca windows observing                       | per-window clocks (worktree, card refresh, agent backstop)          |

Sweep one dimension; hold the rest fixed and state their values. A curve whose other dimensions
moved is not a curve.

## Three instruments, and the one to gate on

Process-level memory uses the census's own metric, `getProcessMemoryMetric()`
(`src/main/memory/process-memory-metric.ts`): **working-set on Windows, rss elsewhere**. The
snapshot already carries `processMemoryMetric` beside the numbers, so the metric name travels with
every figure. Series carrying different metric names are never compared, subtracted or plotted
together — a mismatch is a refusal, not a conversion.

That metric is not, however, the right gate for a terminal pane. The estate holds three figures:

| Instrument | Reachable as | What it cannot see |
| ---------- | ------------ | ------------------ |
| Census working-set / rss | `window.api.memory.getSnapshot()` | memory freed to an allocator free list rather than to the OS |
| V8 heap | `performance.memory.usedJSHeapSize` (needs `--enable-precise-memory-info`) | xterm buffers — typed arrays live outside the V8 heap |
| Retained xterm cells | the live buffers, 3 uint32s per cell | nothing about processes |

Measured on the retention run below: releasing **79.0 MB** of terminal buffer moved the renderer's
working-set by **3.8 MB** and the heap by 4.7 MB. A byte curve over either would have reported about
5% of a reclaim that demonstrably happened — not noise, a systematic floor, because freed typed
arrays return to the allocator rather than the OS.

So for presentation-layer retention: **gate on cells, record bytes.** A byte figure is reported
beside the cell figure, never in place of it, and a working-set reading is gated only as
non-growth. `tests/e2e/terminal-parked-memory.spec.ts` is the worked example.

## Outcome vocabulary

Every point records one of: `measured` · `measured-zero` · `unmeasured` · `failed` · `unavailable` ·
`timeout` · `not-applicable`. `measured-zero` is evidence; the rest are not. A point that could not
be taken is never written as 0, and a composite metric is not derived when any input is not
`measured`.

## Host preconditions

Resource curves are contaminated by the developer's own estate, so each wave records, before **and**
after: free physical memory, the count of live Orca and node processes, and the sorted dirty-path
set of the working tree.

- **≥4 GB free** to start a heavy point (packaged run, ≥50 live runtimes, ≥100 logical rows).
- Headroom that fell below that floor during a run, or a dirty-path set that moved, makes the run
  `inconclusive` — never a failure of the subject.
- A timeout under low headroom is a starvation signature. Re-measure with headroom before assigning
  any failure to the product.

The lab is part of the system it measures: the census itself forks a whole-process-table scan, so
observer cost is measured and reported separately rather than subtracted.

## Stabilization

Wait on the product's own quiescence signal (the store settling, the session list, a completed
sweep), never a fixed sleep. Record which phase a sample belongs to: `startup`, `settling` or
`steady`. Startup spikes are not steady-state density.

## Samples

A single memory reading is not a measurement. Take repeated samples per point, report a median with
the observed range, and say how many samples were taken. Counts (timers, calls, processes) are
load-independent and may be reported from one run; times and bytes may not.

## Scale points

- Logical sessions: 1, 10, 50, 100.
- Live terminals and stand-in agents: 1, 10, 50.
- Cardinality rigs: 1, 10, 50 (`agent-completion-backstop-curve-harness.ts`,
  `worktree-observation-cardinality.test.ts`, `worktree-card-refresh-cardinality.test.ts`).
- Scale perf lab: its own env-driven defaults (10, 25, 50, 100 panes; hidden-pressure axis).

No Cartesian sweep. Points exist to be informative, not exhaustive.

## Metrics this lab publishes

Each is defined here before any number is attached to it.

| Metric                      | Definition                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Dormant Session Tax         | Orca control-plane bytes (canonical metric) at N dormant logical rows minus the same at the base scenario, at steady state.              |
| Marginal Idle Session Cost  | The slope of that curve: added control-plane bytes per additional dormant row over the measured range. Reported with its range.          |
| Active Terminal Tax         | Added control-plane bytes and added recurring work when one dormant row becomes one live plain terminal. Shell bytes are workload, excluded. |
| Agent Management Tax        | Added control-plane bytes and added recurring work per additional live managed agent. The agent's own bytes are workload, excluded.       |
| Hidden Pane Tax             | Retained xterm cells (primary) plus recorded bytes held by a live row that is hidden, against the same row released. Never bytes alone.   |
| Cold Revival Latency        | Explicit Open on a dormant row until its runtime is usable, measured at a small and a dense logical set.                                 |
| Fan-Out Factor              | Effective inspection cardinality over transport cardinality for one due cycle: provider calls, census scans executed and child processes spawned, per leg, divided by requests sent. |
| Reclaim Completeness        | Fraction of created subjects whose PTY and session records are gone after release and quiescence.                                        |
| Leak Slope                  | Change in control-plane bytes across equal create/release lifecycle cycles at steady state, with owned-object counts beside it.           |

**Not defined, therefore not published:** Memory Amplification Ratio (its numerator is ambiguous
between metadata and resident workload) and Control Plane Survival Margin (it cannot be measured
without pushing the host toward exhaustion). A number must not be attached to either name until a
definition lands here.

## Complexity classification

Every recurring or resident cost names the dimension it scales with: per app · per window · per
project · per worktree · per live runtime · per agent · per visible pane · per logical session · per
event · per output byte. Findings are classified as: expected/designed · positive sharing effect ·
linear but justified · linear and optimizable · superlinear · unbounded · leak-like · measurement
artifact · workload cost, not Orca overhead · unknown.

`superlinear` needs more than two points and a stable metric; `leak-like` needs owner evidence
(object counts that never return, or a cache growing per cycle), otherwise the finding is
`residual memory / cache — cause unproven`.

## Two layers of regression protection

Deterministic structural invariants and noisy resource figures do not belong in the same gate.

- **Structural ratchets (CI).** Cardinality and architecture properties, which are exact: one clock
  per window, one batched request per due cycle, no per-pane recurring timer, a dormant row creates
  no runtime, a failed sweep is not zero, workload is not Orca overhead, the terminal host is
  counted once. Owned by the cardinality tests, the collector tests and the recurring-work gate.
- **Lab baselines (manual).** Bytes, times and spawn rates, recorded with provenance and compared
  as trends on the same host and artifact.

No absolute megabyte threshold enters CI. A host-dependent number that fails a build on another
machine is not a gate, it is roulette.

## Result provenance

A recorded point carries: artifact commit; product version; whether the artifact was packaged or dev;
platform and architecture; scenario name; the dimension swept and its value; the held-fixed values of
the other five dimensions; counts (PTYs, sessions, mounted rows, agents, timers, requests,
inspections, spawns); metric name; sample count; median and range; outcome from the vocabulary above;
evidence class; and known confounders. A point missing its scenario, scale or metric name is not a
result.

Evidence classes: `deterministic-unit` · `dev-electron-e2e` · `packaged-product` ·
`referenced-prior-curve` · `stand-in-agent` · `inconclusive`.

## Recorded measurements

**Fan-Out Factor, batched pane inspection** — `9c724c9d4`, dev unit subject, win32 (platform forced),
scenario `batched pty inspection fan-out`, dimension *presentation/terminal runtime* swept at 1, 10
and 50 panes, all other dimensions absent (no app, no window, no worktree). Outcome `measured`,
evidence class `deterministic-unit`. One sample per point: every figure is a call count, which is
load-independent, so no median is owed.

| Panes | Transport requests | Provider inspections | Whole-process-table forks | Panes answered |
| ----- | ------------------ | -------------------- | ------------------------- | -------------- |
| 1     | 1                  | 1                    | 1                         | 1              |
| 10    | 1                  | 10                   | 1                         | 10             |
| 50    | 1                  | 50                   | 1                         | 50             |

Reading: the transport is O(1) per due cycle and the census fork is O(1) per due cycle; the per-pane
leg is an in-memory subtree walk over that one shared snapshot. So the local leg's Fan-Out Factor is
**1 census per cycle at every scale**, and "50 panes means 50 process-table scans" is false for the
local case. Falsified by construction: bypassing the shared reader yields 1/10/50 forks and reds the
census assertion. Confounder: the local provider's own walk is stood in for, so this bounds the
census leg and the batch composition, not the walk's cost.

**Hidden Pane Tax, un-parkable hidden worktree** — `9c724c9d4` + `0e30e7b37` source, dev Electron
(e2e mode, `--enable-precise-memory-info`), win32 x64, scenario `terminal hidden worktree retention
budget`, dimension *presentation* at 4 staged tabs (5 pane managers) × 25,000 scrollback rows, other
dimensions held at one window and one repository. Outcome `measured`, evidence class
`dev-electron-e2e`. One run.

| | Retained cells | Buffer | Renderer working-set | V8 heap | Mounted panes |
| ------ | -------------- | ------ | -------------------- | ------- | ------------- |
| before | 6,910,211      | 79.1 MB | 376.0 MB            | 168.6 MB | 5            |
| after  | 6,307          | 0.1 MB  | 372.2 MB            | 163.9 MB | 1            |

Readings: a hidden un-parkable pane holds roughly **1.4M cells / ~16 MB of buffer per pane** at that
scrollback depth, and the budget released 99.91% of it in **118 ms** (bound: 2,000 ms). The two byte
instruments each saw under 5% of that release, which is why the gate is the cell count. Confounders,
from the spec's own notes: the un-parkable class is staged by rewriting `ptyId` to a
remote-runtime-shaped id, so park-restorability is faithful but the transports underneath are real
local PTYs — not a live remote runtime. Host bracket: 13.2 GB free before, 15.2 GB after, never near
the 4 GB floor.

**The daemon, SSH and runtime legs are not covered by that number.** A daemon-backed pane is
inspected by one RPC per session (`src/main/daemon/daemon-pty-adapter.ts:1562` sends
`inspectProcess` with a single `sessionId`), so those legs are linear in panes by construction —
code-read evidence, `unmeasured`, and deliberately left per-session because the daemon's protocol
version is part of its endpoint.

## What this protocol cannot judge

- Stand-in agents measure Orca's management cost. They are never evidence about real provider
  sessions, at any count.
- Logical scale is not agent scale. A hundred dormant rows says nothing about a hundred live agents.
- The lab cannot prove a stated bound is true; it measures what a cost scales with.
