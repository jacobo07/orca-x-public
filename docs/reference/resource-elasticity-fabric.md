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

Still open for R1: the packaged application's own Resource Manager has never been looked at. The
unit and dev-Electron evidence is not a substitute, so R1 is not product-real until the packaged
surface shows the terminal-host row, keeps workload out of Orca overhead, and reads Unmeasured —
not zero — when the sweep fails. It is folded into R3's packaged run.

## R3 — density is measured per resource dimension, not per pane

[The Resource Density Lab](./resource-density-lab.md) is the protocol: the six dimensions kept apart
(logical, presentation, terminal runtime, agent runtime, repository, window), the canonical metric,
the outcome vocabulary that keeps unmeasured away from zero, host preconditions and stabilization,
scale points, the metric definitions, and the split between structural ratchets in CI and noisy lab
baselines outside it.

It exists because the earlier waves measured producers, not the system: fewer timers is not less
work, and one batched request is not one unit of work. Effective inspection cardinality — how many
provider calls, census scans and process spawns one due cycle really performs, per leg — is the first
question it asks.

Measurements are recorded as they land. Every metric is defined in that document before a number is
attached to it, and the eleven metric names inherited from the program plan were undefined anywhere
in this repository until then; two of them remain undefined and unpublished on purpose.

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
- **Real-app regression proof.** Disabling the git-common run in the built app turns the e2e spec
  red.
- **Still open.**
  - A base-root listing error other than ENOENT still reads as "every worktree deleted". The
    cost is one wasted structure refresh, because the renderer re-lists from git, not lost data.
  - The quiet tier also stretches the 15-run index backstop to 150 s for idle repos.

## Second shrink — worktree card decorations share one clock per window

`worktree-card-hosted-review-poll` and `worktree-card-linked-issue-poll` were removed from the
baseline (3 → 1).

- **What actually multiplied.** Every mounted worktree card owned two intervals: hosted review
  every 60 s and linked issue every 5 min. The list is virtualized, so this scaled with mounted
  cards rather than remembered worktrees, but four surfaces mount cards and one worktree can have
  more than one. The expensive work did not multiply in the same way:
  - The renderer caches already collapsed duplicate subjects into one IPC call.
  - Main serves `hostedReview:forBranch` from one process-wide cache for every window and paces
    the provider calls (found reviews 60 s, no review 15 min).
  - `gh:issue` has no main-side cache and starts one `gh` per call.
- **Owner.** `src/renderer/src/components/sidebar/worktree-card-decoration-refresh.ts`, one per
  renderer.
  - Cards register a subject keyed by every argument they send. One visibility-gated interval
    runs both families, each on its own cadence.
  - The clock arms on the first registration and disarms on the last, and one subject's failure
    does not skip the others.
  - Freshness and in-flight dedup stay in the store fetchers. The clock does not await, so a slow
    lookup is single-flighted there rather than queued.
- **Measured** by `worktree-card-refresh-cardinality.test.ts`, which drives the real hook and the
  real store fetchers over a 10 min window.

  | mounted cards (worktrees) | intervals before → after | store lookups before → after | IPC before → after |
  | ------------------------- | ------------------------ | ---------------------------- | ------------------ |
  | 1 (1)                     | 2 → 1                    | 14 → 14                      | 14 → 14            |
  | 10 (10)                   | 20 → 1                   | 140 → 140                    | 140 → 140          |
  | 50 (50)                   | 100 → 1                  | 700 → 700                    | 700 → 700          |
  | 50 (25)                   | 100 → 1                  | 700 → 350                    | 350 → 350          |

  IPC per distinct visible worktree is unchanged by design: each one still needs its own lookup.
  Hidden windows make no calls before or after, and unmounting every card leaves no interval.

- **Freshness was half what was declared, before and after the clock.**
  - Each poll ran at exactly its cache TTL, and entries are stamped when the answer arrives. The
    next tick found the entry younger than the TTL by the lookup latency and skipped it.
  - The running app refreshed linked issues at 0 and 10 min.
  - Scheduled refreshes now ask for a max age of 90% of the interval. The store accepts it only to
    shorten its TTL.
  - Real lookups per subject therefore return to the declared 60 s and 5 min. For linked issues
    that doubles the `gh` spawns observed before the fix.
- **Product reality.** `tests/e2e/worktree-card-decoration-refresh.spec.ts` puts a fake `gh` first
  on PATH and changes PR and issue titles in its state file. It asserts that the entries the cards
  read follow the change, and it reads the clock through an e2e-only renderer hook.
  - On Windows the fake is a compiled `gh.exe`: Node's `execFile` never runs a `gh.cmd`.
  - Disconnecting the linked-issue refresh in a built app turns it red.
- **Not in the display path.** Workspace cleanup reads the hosted-review cache for labels and
  filters only; eligibility comes from the main-side candidate.
- **Regression proof.** Fifteen mutations each turn a test or the gate red:
  - a clock per card, for both families and for each alone;
  - one clock that still asks per card;
  - a timer left running at zero subscribers;
  - polling while hidden;
  - one failure aborting the tick;
  - the store's in-flight dedup removed;
  - stale arguments kept, and a released subject still run;
  - the issue family at the review cadence;
  - the issue refresh disconnected;
  - the max age ignored, and the max age allowed to extend the TTL;
  - a planted per-card interval (gate).
- **Still open.**
  - Issue lookups are per window: two windows showing one issue start two `gh` processes.
  - A failed issue lookup is cached as "no issue" for 5 min, because main turns every failure
    into `null`.

## Third shrink — every pane's process-exit backstop shares one clock and one call per window

`agent-completion-process-backstop` was the last debt in the baseline.

- **What the backstop is for.** Hooks and terminal titles report completion as soon as they
  arrive. Only the backstop notices an agent process that exits without saying so: an agent with
  no hooks, a hook lost to a crash, or a title that never flips. It needs two idle readings in a
  row, and an unknown reading (terminal gone, call failed) resets that count.
- **What actually multiplied.** Every live, connected pane owned a self-rescheduling timeout
  (750 ms with an agent, 2 s idle, 3 s hidden with agent evidence, 15 s with no evidence on
  Windows) and made its own `pty:inspectProcess` call. A per-window queue capped starts at 8 per
  second, so beyond about six agent panes the cost moved from calls into detection time.
- **Owner.** `src/renderer/src/components/terminal-pane/agent-process-backstop.ts`, one per
  renderer.
  - Panes register a due time instead of owning a timer. The one timer fires at the earliest
    due pane and runs every pane due within 30% of its own interval, so cadences line up.
  - A tick's requests leave in one `pty:inspectProcesses` call. Each pane keeps its own tier,
    its two-sample exit proof and its generation fence, and applies only its own answer.
  - One call per host at a time. Panes that come due meanwhile go in the next call, and a slow
    runtime host does not hold local panes.
  - A pane disposed before its call leaves is never sent. The timer disarms when no pane is
    scheduled.
- **Per-pane truth.** Main answers each id separately (`pty-process-inspection-batch.ts`): an
  inspection, or `failed` for a thrown call, a hung call (10 s deadline) or a missing provider.
  An unanswered id or a lost envelope is also `failed`, and `failed` never reads as an idle
  shell. The web client answers every id as failed.
- **Mixed versions.** The renderer and main ship together, so the new IPC name has no version
  boundary; the preload method is optional, and a surface without it falls back to one call per
  pane. The daemon protocol did not move: its version is part of the endpoint, so a bump would
  leave every running v36 daemon adopted beside a new one after each update. Main therefore
  still asks the daemon one request per session; each is a read of that session's short
  foreground cache.
- **Measured** by `agent-completion-coordinator-cardinality.test.ts` through
  `agent-completion-backstop-curve-harness.ts`: real coordinators and backstop, every pane running
  an agent, a silent exit halfway through a 60 s window.

  | panes | timers before → after | per-pane calls before → after | shared calls after | exit noticed before → after |
  | ----- | --------------------- | ----------------------------- | ------------------ | --------------------------- |
  | 1     | 1 → 1                 | 54 → 0                        | 54                 | 1.25 s → 1.25 s             |
  | 10    | 10 → 1                | 464 → 0                       | 78                 | 1.23 s → 1.25 s             |
  | 50    | 50 → 1                | 464 → 0                       | 78                 | 9.29 s → 1.25 s             |

  Every pane is now inspected at its declared cadence: 761 and 3,881 per-pane answers at 10 and
  50, against 464 under the cap. Main and the daemon therefore do more per-pane reads than
  before at high counts. That is the freshness the tiers always declared, and each read is
  in-memory apart from the process-table scan behind it.
- **What still scales with panes.**
  - Main to daemon: one socket request per session per tick.
  - SSH panes: one relay request each.
  - Runtime-owned panes: one `terminal.inspectProcess` RPC each (the runtime has no batch
    method).
  - On Windows, the daemon's whole-process-table scan was already shared (one in flight,
    500 ms reuse) and throttled per session, so it is capped per process rather than per pane.
    Each pane still walks its own subtree of that scan in memory.
- **Regression proof.** Sixteen drills each turn a test red:
  - a timer per pane;
  - one timer that still asks per pane;
  - a failure read as idle;
  - one failure failing the whole call;
  - answers matched by position;
  - the generation fence removed;
  - a timer left armed with no panes;
  - overlapping calls;
  - a hook waiting for the backstop;
  - an unanswered pane read as idle;
  - a surface without the batch method read as success;
  - a new timer per pane;
  - a lost envelope read as idle;
  - a disposed pane still sent;
  - main without its per-pane deadline;
  - main failing every pane for one failure.

  The generation-fence drill survived at first. The test's stale answer was idle, which is
  harmless either way. It now sends a stale *live* answer, which would lend a restarted pane agent
  evidence and so report an exit that never happened.
- **Product reality.** `tests/e2e/agent-completion-backstop.spec.ts` (Windows) splits one tab into
  four panes. Each runs a compiled `gemini.exe` stand-in that emits no hooks and no titles, and a
  main-process spy counts inspection IPC.
  - Over 6 s: one armed timer, 8–9 shared calls carrying all four ids, and no per-pane calls.
  - A stop file written from outside Electron is reported once, for its pane only, in 6–7 s. The
    notification is titled `gemini`, a name only the process-exit path gives a completion.
  - The Windows daemon keeps trusting a cached agent until console membership confirms the exit,
    and that caching, not the clock, sets the 6 s.
  - One run failed to recognise any agent while the host was under memory pressure. The same
    build then passed on rerun.
- **Broken builds.**
  - Discarding every answer turns the spec red: panes back off and the steady window sees no call.
  - Delivering live answers but dropping idle ones turns it red where intended. Steady state
    passes, and the exit is never noticed.
  - Restored builds pass.
- **Ratchet at zero.** With the baseline empty, the gate still rejects:
  - a new self-rescheduling per-pane poll, as unclassified;
  - the same poll classified as debt, as new debt;
  - a timer planted back into the coordinator, as unclassified.
- **Still open.**
  - Runtime-owned panes could share one `terminal.inspectProcesses` per environment. The runtime
    already negotiates capabilities.
  - The 6 s Windows real-app detection has not been investigated.
  - No real-app run at 10 or 50 panes; those counts are covered by the unit curve only.
