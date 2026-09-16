---
covers:
  [
    resource-elasticity,
    resource-census,
    terminal-host-attribution,
    density-lab,
    observation-budget,
    stream-taxonomy,
    pressure-model,
    resource-governor,
    recurring-work-inventory,
    recurring-work-ratchet
  ]
status: active
---

# Resource Elasticity Fabric

Orca should be able to remember far more logical work than it keeps resident. This spec is the
composition layer over owners that already exist. It is not a new subsystem. Wave numbering is
from the 2026-09-16 program plan.

## Owners this spec composes, and does not replace

| Concern                | Canonical owner                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Presentation eviction  | cold parking (`terminal-hidden-view-parking.ts`), force-park retention (`terminal-hidden-worktree-retention.ts`), hidden WebGL LRU (`terminal-webgl-hidden-retention.ts`)                                    |
| Terminal output bounds | main pending/in-flight windows and producer flow control (`src/main/ipc/pty.ts`), daemon batcher and keep-tail (`src/main/daemon/daemon-stream-*`), renderer scheduler (`pane-terminal-output-scheduler.ts`) |
| Destructive reclaim    | the agent hibernation coordinator and its authorization plan; the governor only ever requests                                                                                                                |
| Dormant composition    | the project working-set program (W1–W6)                                                                                                                                                                      |
| Resource census        | `src/main/memory/collector.ts`                                                                                                                                                                               |

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

R2 needed no code: R1's layout already separates Orca overhead (the Orca group, including the
terminal host), workload (project groups) and unattributed memory.

## R4 — recurring work is inventoried, and the debt list only shrinks

A timer that costs nothing with three panes is structural debt at a hundred. R4 makes every
recurring producer in `src/` name what multiplies it.

- `config/recurring-work-inventory.jsonc` classifies every site the sweep finds: intervals,
  self-rescheduling timeouts and animation frames, watchers, workers and child processes, and the
  call sites of scheduler helpers that take a callback. Each entry records cadence, lifetime,
  scaling, hidden and dormant behaviour, spawned binaries and a disposition.
- `pnpm check:recurring-work` (part of `pnpm lint`) fails on an unclassified site, a stale entry, a
  multiplicative producer marked justified without a stated `bound`, a spawn reached from a
  callback declared as spawning nothing, a `debt` responsibility missing from
  `config/recurring-work-debt-baseline.txt`, a baseline line that is no longer debt, and a sweep that
  finds less than its floor.
- Site keys are file, kind and enclosing symbol. Renaming or moving a producer re-keys it, so debt
  cannot be renamed away; it has to be classified again.
- Cardinality is proven per responsibility with a runtime test, not by the gate. The first is
  `agent-completion-coordinator-cardinality.test.ts`.

What the sweep cannot see, by construction (it is a text scan; the repo declares no JS parser):

- a timer reached through an alias or an undeclared helper;
- a reschedule that crosses modules, or needs more than three same-file calls to come back;
- a spawn more than one call away from the callback (the `spawns` field is declared, not proven);
- recurring work outside `src/` (for example `mobile/`);
- whether a stated `bound` is true. Turning `debt` into `justified` with an invented bound passes
  the gate; that edit is caught only in review, which is why dispositions live in one diffable file.

Findings from the first inventory:

- The agent-completion process backstop polls once per connected live pane, not per remembered
  session: slept panes, non-live panes and hidden panes without agent evidence cost nothing, and
  cold parking bounds the mounted set. The per-window queue caps volume at 8 starts per second, so
  past that the cost becomes detection latency. A queued inspection used to run after its pane was
  disposed; fixed in R4.
- It stays listed as debt: every pane still makes its own IPC round trip, and the Windows
  process-table cache only merges scans that happen to land within 500 ms of each other.

## First shrink — worktree polls share one clock and slow down when quiet

`worktree-base-and-git-common-stat-poll` was the first debt removed from the baseline (4 → 3).

- **What actually multiplied.** Base targets are keyed by workspace root, so repos sharing the
  global workspace directory already shared one poll. The multiplier was git-common: one target
  per repo, each with its own 2 s timer and about 7 + 6×(linked worktrees) stats per tick, running
  for every repo in the store.
- **Owner.** `src/main/ipc/worktree-observation-clock.ts`. Every local worktree poll (base,
  git-common, the macOS primary poll and existence poll) registers a run instead of scheduling
  itself. There is one timer per interval, at most 4 runs at once, and no target overlaps itself.
  One target's failure is isolated. The timer disarms when every target is parked (hidden
  window) or gone.
- **Freshness contract.**
  - A target runs every 2 s if it emitted an event in the last 2 minutes, holds the active
    git-status upstream ref, or has just been woken by its window becoming visible.
  - Otherwise it runs every 10 s. Any change it sees puts it back on 2 s.
  - Orca's own worktree operations still notify directly.
- **Measured** by `worktree-observation-cardinality.test.ts`: real target builder, 3 linked
  worktrees per repo, 20 s window.

  | repos | timers before → after | idle stat calls before → after |
  | ----- | --------------------- | ------------------------------ |
  | 1     | 2 → 1                 | 266 → 52                       |
  | 10    | 11 → 1                | 2570 → 502                     |
  | 50    | 51 → 1                | 12810 → 2502                   |

  Active-cadence work is unchanged by design. The slope is still linear in repos; the constant is
  five times smaller when they are idle.
- **External changes stay observed.**
  - `worktree-external-change-golden.test.ts` runs real `git worktree add` and `remove` from
    outside the watcher, while the repo is active and after it has gone quiet.
  - `tests/e2e/worktree-external-change-observation.spec.ts` does the same in the running app,
    with no explicit fetch, and reads the clock through an e2e-only hook.
- **Regression proof.** Ten mutations each turn a test or the gate red:
  - a clock per target, and a planted per-target timer;
  - no quiet tier, and no quiet fallback;
  - no reactivation;
  - a skipped worktrees listing;
  - a zero-target timer leak;
  - overlapping runs, and one failure halting all;
  - un-deduplicated targets.
  Disabling the git-common run in the built app turns the e2e spec red.
- **Still open.**
  - A base-root listing error other than ENOENT still reads as "every worktree deleted". The
    cost is one wasted structure refresh, because the renderer re-lists from git, not lost data.
  - The quiet tier also stretches the 15-run index backstop to 150 s for idle repos.
