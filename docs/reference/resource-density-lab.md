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
| Dormant Row State Footprint | Control-plane state one remembered row adds when a working set is restored: store objects installed, manifest bytes reaching disk, and the runtimes and recurring producers it arms. Measured through the real capture, plan and apply functions over one store, so it is load- and host-independent. |
| Dormant Row Presentation Footprint | What one presentation surface holds per dormant row it renders: DOM elements, and live store subscribers read from the store's own listener census. Counts from the real component over the real store, so load-independent. Stated per surface. |
| Dormant Session Tax         | Orca control-plane bytes (canonical metric) at N dormant logical rows minus the same at the base scenario, at steady state.              |
| Marginal Idle Session Cost  | The slope of that curve: added control-plane bytes per additional dormant row over the measured range. Reported with its range.          |
| Active Terminal Tax         | Added control-plane bytes and added recurring work when one dormant row becomes one live plain terminal. Shell bytes are workload, excluded. |
| Agent Management Tax        | Added control-plane bytes and added recurring work per additional live managed agent. The agent's own bytes are workload, excluded.       |
| Hidden Pane Tax             | Retained xterm cells (primary) plus recorded bytes held by a live row that is hidden, against the same row released. Never bytes alone.   |
| Cold Revival Latency        | Explicit Open on a dormant row until its runtime is usable, measured at a small and a dense logical set.                                 |
| Fan-Out Factor              | Effective inspection cardinality over transport cardinality for one due cycle: provider calls, census scans executed and child processes spawned, per leg, divided by requests sent. |
| Reclaim Completeness        | Fraction of created subjects whose PTY and session records are gone after release and quiescence.                                        |
| Leak Slope                  | Change in control-plane bytes across equal create/release lifecycle cycles at steady state, with owned-object counts beside it.           |

Dormant Row State Footprint is a **state** figure at the renderer-store altitude. It is the
deterministic floor under the logical dimension and it is never a substitute for the Dormant
Session Tax, which is process bytes in a running app: a store object's cost in resident memory is
not derivable from its shape. Because it costs no host, it is taken at scales the byte curve
cannot safely reach, and a point it covers is not thereby covered for the process metric.

**Not defined, therefore not published:** Memory Amplification Ratio (its numerator is ambiguous
between metadata and resident workload) and Control Plane Survival Margin (it cannot be measured
without pushing the host toward exhaustion). A number must not be attached to either name until a
definition lands here.

## Cold Revival Latency: where the stopwatch stops, and which row it may time

"Until its runtime is usable" names three different moments. They are recorded separately, because
the gap between them is what says which layer owns the time:

| Rung | What is true | Read through |
| ---- | ------------ | ------------ |
| T1 runtime bound | the row holds a PTY id | `ptyIdsByTabId[tabId]` non-empty |
| T2 surface mounted | that tab has an xterm/PTY pair | `__paneManagers.get(tabId)`, active pane's `container.dataset.ptyId` |
| T3 usable | the shell has painted its first byte | `getTerminalContent` — the SerializeAddon the PaneManager already loads |

**T3 is the published figure.** T1 is "a PTY object exists", which a revival reaches while the user
is still looking at an empty pane; publishing the fastest rung as the metric would report a number
nobody experiences. The stopwatch starts at the `dormant-terminal-open` click — the user's own
action — not at the activation that merely reveals the placeholder.

It stops at first paint rather than at an echoed probe command. A probe measures the shell's round
trip, and the shell is workload: the same invariant that keeps a user shell's bytes out of Orca
overhead keeps its startup out of Orca's revival latency. First paint is therefore an upper bound on
Orca's work and a lower bound on the user's wait, and that difference is named rather than folded in.

**One row kind per series.** The cloned rail alternates — every second row carries a sealed provider
session, the rest restart plain — and the two revive through different paths, so a series that
changes kind between its points is not a curve. The clone truncates to the first source row at N=1,
where only the sealed kind exists, so the sealed series is the one that spans every scale and the
plain-restart series begins at N=2. Neither may be reported as the other, and the kind is recorded
with the figure.

Latency is a time, so unlike the counts in the structural rig it is **invalid on a busy host**: it
takes the same ≥4 GB floor, the same before-and-after bracket, and the same median-with-range as the
byte curve.

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

Tree bracket: the dirty-path set moved during the window — a concurrent writer touched seven paths.
Five landed after the bundle was built (mtime against the artifact) and two are test files outside
the app's import closure, so they cannot be in what was measured. One was inside it:
`worktree-purge-state.ts`, modified three minutes before the renderer bundle and reachable from the
worktree store lookups this scenario exercises. The measured mechanism does not read purge state,
and the run's own mount-count assertions (5 before, 1 after, decoy exemption held) behaved as
specified — so this is recorded as **attributable with a named confounder**, not as a clean-tree run.

**Dormant Row State Footprint, restored rail** — `f4e2b4f05`, dev unit subject, 1.4.178-rc.2,
win32 x64, scenario `restored dormant rail`, dimension *logical session* swept at 1, 10, 50 and 100
rows. Every other dimension is absent by construction: no app, no window, no repository observation,
no runtime and no agent — the subject is the capture, plan and apply functions over one store.
Outcome `measured`, evidence class `deterministic-unit`. One sample per point: every figure is a
count or a serialized length, so no median is owed.

| Rows | Store objects | Resume handles | Workspace state | Manifest | Rows the mount authority would mount |
| ---- | ------------- | -------------- | --------------- | -------- | ------------------------------------ |
| 1    | 5             | 1              | 1,590 B         | 820 B    | 0                                    |
| 10   | 45            | 5              | 11,295 B        | 4,721 B  | 0                                    |
| 50   | 225           | 25             | 55,875 B        | 22,411 B | 0                                    |
| 100  | 450           | 50             | 111,549 B       | 44,523 B | 0                                    |

Readings: store objects are **exactly** `4n + ceil(n/2)` at every point — one row, one unified tab,
one group member and one layout each, plus a resume handle for every second row, which is the half
of this rail carrying a sealed agent session. State costs **~1,114 B per row** and the manifest
**~442 B per row**; the 1→10 slope is 3% lower only because the single-row point carries the odd
half of the agent parity. So a hundred remembered rows is about **109 KB of workspace state and
43 KB on disk**, and no timer is armed at any scale.

The mount column is the load-bearing one. It is `decideTerminalTabMount`'s own answer with **no
render restriction in force**, so nothing but dormancy can hold a row back — the restriction
dissolves at its threshold, after a full reveal and under its kill switch, and dormancy must not.
Asking the authority rather than reading `ptyId` is not a stylistic choice: hydration normalizes
that field to null whatever the payload carried, so a restore that installs a runtime **survives**
an assertion on it. That mutation did survive, and the instrument was changed rather than the score.

Confounders: the rail is synthetic (one pane per row, every second row a resumable Claude session,
eight rows per group) and restore-time evidence confirms every sealed fact, so capability is held
constant rather than swept. This is a **state** figure at the store altitude — it says nothing about
resident bytes, and the 100-row point it reaches for free is **not** thereby covered for the process
metric. Tree bracket: the dirty-path set was identical before and after (22 paths, none moved).

**Logical dimension, real Electron — structural Product Reality** — `dormant-rail-density.spec.ts`,
dev Electron (e2e mode), 1.4.178-rc.2, win32 x64, scenario `restored dormant rail at fifty rows`,
dimension *logical session* at 50, other dimensions held at one window, one repository, one execution
host. Outcome `measured`, evidence class `dev-electron-e2e`. One run per assertion; every figure is a
count, which is load-independent, so no median is owed and host pressure does not invalidate it.

The seed is not authored. Two rows are captured live through the real producer, then
`cloneWorkingSetToScale` multiplies that captured shape to fifty, regenerating only tab ids, leaf ids
and provider session ids. Labels are deliberately *not* regenerated: all fifty rows show one title,
so identity can only be resolved by tab id. The scaled manifest is written into the store beside the
one the product wrote, and the app reads it back through its own sealed reader.

| | Rail rows | Rows with a process | New host sessions vs baseline |
| ---- | --------- | ------------------- | ----------------------------- |
| after restore | 50 | 0 | 0 |
| after activating all fifty | 50 | 0 | 0 |
| after one Open, mid-rail | 50 | 1 (exactly the opened row) | 1 |
| after workspace Sleep | 50 | 0 | 0 |

Readings: fifty remembered rows restore with **no** runtime, activating every one of them is
composition rather than an open, a single Open materializes **exactly** its own row out of fifty
sharing one title, and the canonical reclaim releases that runtime while all fifty logical rows
survive. `project-working-set-restore.spec.ts` already proved this shape at three rows; three cannot
fail it in an interesting way, because a title-keyed, index-keyed or wake-everything defect is
invisible on a rail small enough to get right by accident.

Two instrument notes, both of which produced a wrong answer first. A baseline taken the instant the
store empties is not a baseline: the host registers and unregisters PTYs on its own schedule, so a
session from the seeding phase surfaced *after* the read and was indistinguishable from one the
restore had started. The baseline now waits for the host's own list to stop moving and fails loudly
if it never does. And an evidence line printed only after the reclaim reads `newMainSessions=0`
whether one row woke or nothing ever happened, so the peak is now asserted and recorded separately.

Broken build: removing the dormancy marker from the apply payload, rebuilding the real artifact and
re-running turns it red — main lists a rolling set of PTYs bound to no opened row across all twelve
samples, which is fifty remembered rows materializing. Restored by SHA-256, rebuilt, green.

That ordering took two attempts and the first two are worth recording. The mutation initially failed
at the dormancy-marker assertion, and then at the dormant placeholder's absence — both upstream of
the process window, so the drill was proving the spec noticed a missing marker rather than that
nothing had spawned. The spec now judges **processes before chrome**: a missing placeholder is a
symptom, a running shell is the defect.

Confounders: row 25 of the cycle is the **non-agent** source row, so the Open exercises a plain
restart rather than an exact provider resume — the resume leg at scale is `unmeasured`. The agent
stand-in is a seeded provider-session store entry, not a live agent. Host bracket: this run is
`measured` for counts only; free memory fell to 0.58 GB during the session, so **no byte or latency
figure was taken**, and the Dormant Session Tax, Marginal Idle Session Cost and Cold Revival Latency
remain `unmeasured` pending a host above the 4 GB floor.

**Dormant Session Tax and Marginal Idle Session Cost** — `dormant-rail-memory-curve.spec.ts`, dev
Electron (e2e mode), 1.4.178-rc.2, win32 x64, scenario `dormant rail memory curve`, dimension
*logical session* at 0, 1, 10 and 50, other dimensions held at one window, one repository, one
execution host and zero runtimes (asserted at every point). Metric `working-set`, asserted constant
across the run. Five samples per point, median with observed range, one fresh app per point so no
point inherits another's allocator high-water mark. Outcome `measured`. Evidence class
`dev-electron-e2e`.

| Sweep | Rows | Orca | main | renderer | terminal host | workload | unattributed | sample range |
| ----- | ---- | ------- | ----- | -------- | ------------- | -------- | ------------ | ------------ |
| fwd   | 0    | 767.7 MB | 268.7 | 214.5 | 87.5 | 101.6 | 11.4 | 12.3 |
| fwd   | 1    | 766.9 MB | 267.1 | 213.0 | 89.1 | 101.0 | 11.4 | 0.5 |
| fwd   | 10   | 786.9 MB | 272.9 | 226.2 | 89.5 | 101.0 | 11.4 | 8.9 |
| fwd   | 50   | 809.0 MB | 277.3 | 242.3 | 90.7 | 101.0 | 11.4 | 1.5 |
| rev   | 50   | 829.8 MB | 281.1 | 260.4 | 90.9 | 101.0 | 11.4 | 0.8 |
| rev   | 10   | 818.3 MB | 276.4 | 253.2 | 91.1 | 100.7 | 11.4 | 0.7 |
| rev   | 1    | 790.9 MB | 279.1 | 223.8 | 92.4 | 100.7 | 11.4 | 70.6 |
| rev   | 0    | 775.3 MB | 269.9 | 217.3 | 92.4 | 100.7 | 11.4 | 9.7 |

**Dormant Session Tax at 50 rows: +41.3 MB forward, +54.4 MB reversed.** **Marginal Idle Session
Cost: ≈0.8–1.1 MB per remembered row**, reported as a range because the two sweeps disagree by that
much. At 1 row the cost is **below detection** — forward reads −0.9 MB, reversed +15.6 MB, and that
reversed point's own five samples spanned 70.6 MB.

**Why the row effect is separable from host drift, which is the only reason these numbers are
reportable.** Free host memory fell monotonically through the run, 5,049 → 4,382 MB, as other
processes on the machine grew. In the forward sweep that drift rises together with the row count, so
the two are confounded and the forward curve alone proves nothing. In the reversed sweep the host
kept draining while the row count fell — and Orca's bytes fell **with the rows**, 829.8 → 775.3 MB.
Drift would have held them flat or pushed them up. The reversed sweep is the control, and running it
is what turned an unusable curve into a defensible one.

**What the cost is made of.** Of the tax at 50 rows, **68% (forward) to 79% (reversed) is renderer**;
main accounts for 8.6–11.2 MB. **The terminal host is flat** — 87.5 → 90.7 forward and 92.4 → 90.9
reversed, moving by ~3 MB in either direction across 0 to 50 rows, so a dormant row costs the daemon
nothing. **Workload is flat** at 100.7–101.6 MB and **unattributed is exactly flat** at 11.4 MB in all
eight points: the byte-level confirmation of the structural result that dormant rows create no
workload.

Set against the store altitude, where 50 rows cost 55,875 bytes of workspace state, the process cost
is roughly **800–1,000× the data it represents**. The data is trivial; the renderer's representation
of it is the whole tax, and that is the next dimension to measure.

Confounders: host drift as described, bounded by the reversed sweep rather than eliminated; the base
point is the same app with an emptied workspace, and the data shows no activation offset (base
renderer 214.5/217.3 against 213.0/223.8 at one row); the rail is seeded from a cloned two-row
capture, so all fifty rows share one launch shape. One sweep of each direction — not a repeated
experiment.

**The daemon, SSH and runtime legs are not covered by that number.** A daemon-backed pane is
inspected by one RPC per session (`src/main/daemon/daemon-pty-adapter.ts:1562` sends
`inspectProcess` with a single `sessionId`), so those legs are linear in panes by construction —
code-read evidence, `unmeasured`, and deliberately left per-session because the daemon's protocol
version is part of its endpoint.

### Dormant Row Presentation Footprint — terminal rail (2026-09-18)

`src/renderer/src/components/terminal-rail/terminal-rail-presentation-residency.test.tsx` renders the
real `TerminalRail`, with the `tabActions` production always passes, over the real store at 1, 10
and 50 dormant rows. Each row has a layout naming its pane and no PTY. Subscribers come from
`readStoreListenerCount()`, the census installed on the store's inner api. Outcome `measured`.
Evidence class `renderer-unit`.

| Rows | DOM elements | live store subscribers | rows in DOM | previews connected |
| ---- | ------------ | ---------------------- | ----------- | ------------------ |
| 1    | 12           | 28                     | 1           | 0                  |
| 10   | 93           | 244                    | 10          | 0                  |
| 50   | 453          | 1,204                  | 50          | 0                  |

**Per dormant row: 9 DOM elements and 24 store subscribers, exactly linear.** The slope is taken
from the 1- and 50-row points and predicts the 10-row point exactly. **The rail is not virtualized.**
It maps every row into an `overflow-y-auto` div, so a row scrolled out of view is still a mounted
subtree. The estate ships `@tanstack/react-virtual` and uses it in three other lists, so this is a
choice, not a missing tool. Subscribers are released on unmount, back to baseline at every point.

**Where the 24 come from (read from source; the total is measured).** `useTabAgent` holds 13
subscribers. Several of them allocate on every evaluation: one builds a `Set` of PTY ids and spreads
it into an array. `TerminalRailTab` holds 6, `TerminalPreviewHoverTrigger` 2, and the per-row context
menu and icon hold the rest. Each subscriber re-runs its selector on **every** store write anywhere
in the app, so 50 dormant rows add 1,204 selector evaluations to every write, and none of those rows
has anything to report.

**What this does not explain.** 453 DOM elements and a few kilobytes of hook state per row cannot
be the ~1 MB per row the byte curve found in the renderer. The rail's cost is **CPU per store
write, not resident bytes**. The megabyte is still unattributed at this altitude.

**The tab strip holds a second set per tab (read from source, runtime `unmeasured`).**
`SortableTab` also calls `useTabAgent`, and `tab-bar/` uses no virtualizer. So the ~13-subscriber
agent resolution runs twice for every dormant tab, once per surface, from identical inputs. A
dormant tab rendered nowhere costs the overlay layer nothing: `TerminalPaneOverlayLayer` returns
null for a hidden dormant tab.

Mutation drills, each restored and verified by SHA-256. Rendering only the first 10 rows (a
windowing stand-in) reds both cases: rows read `[1, 10, 10]` and the slope stops being a whole
number. Adding one subscriber per row reds the ratchet at exactly `24 → 25` while the
virtualization case stays green.

## What this protocol cannot judge

- Stand-in agents measure Orca's management cost. They are never evidence about real provider
  sessions, at any count.
- Logical scale is not agent scale. A hundred dormant rows says nothing about a hundred live agents.
- The lab cannot prove a stated bound is true; it measures what a cost scales with.
