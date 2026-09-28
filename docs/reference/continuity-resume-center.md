---
covers: [resume-center, continuity, desk-projection, wake-admission, desk-snapshot, park-multi-window, cursor-continuity]
status: PLANNED
---

# Continuity and the Resume Center

The previous desk (which windows, workspaces and panes existed, and what state each is in) is already
durable. This program shows it, restores it without waking processes, and resumes it at a pace the
host can afford. It adds no second store for anything an owner already keeps.

Every capability below carries a status: **LIVE** (implemented and exercised), **PLANNED**, or
**UNSUPPORTED** (outside what the platform or a third party exposes). A sentence here may not run
ahead of its status.

## Owners this program composes (none replaced)

| State | Owner |
|---|---|
| Tabs, splits, editors, browser, sleeping agents per worktree and host | `WorkspaceSessionState` (profile file, continuous writes) |
| Which windows existed | `ui.windowTopology` (`src/main/window/window-topology*.ts`) |
| Resume verdict per pane | `DormantResumeContinuity` (`exact`/`unconfirmed`/`claimed-elsewhere`/`none`) |
| Local terminal history | terminal daemon checkpoint + log (`src/main/daemon/history-reader.ts`) |
| Remote terminal history | session scrollback refs (`src/main/terminal-scrollback-snapshots.ts`) |
| Per-workspace historical snapshot | Working Sets (`src/main/project-working-set/`) |
| Release at exit | Park & Exit (`src/main/durable-exit/`) |
| Host headroom | `observeDispatchHostResources` (orchestration) |
| Live-session collision | `gateLiveSessionMaterialization` |
| Cursor hooks | `src/main/cursor/hook-service.ts` |

## Semantics

- **An ordinary quit keeps the desk warm.** The daemon keeps local sessions and relaunch reattaches
  to them. Reattach is not a wake and is never gated.
- **"Dormant" is a release at close, never a startup gate.** Choosing dormant runs Park & Exit across
  every window: plan all, refuse the whole exit on anything busy, unsent or unknown, seal resume
  ids, release, read back. When Park refuses, the app quits warm and says so. A standing preference
  never authorizes releasing work the user did not see; it only selects which transaction is
  attempted. Default: warm. PLANNED.
- **Restore layout only** is the Resume Center's **Open**. Every row the host does not list as
  running gets the `layout-restore` dormancy marker (through `terminalTabDormancy`), then the
  workspace activates with `wake: false`: no sleeping-agent resume, no seeded terminal, no host
  terminal after wake. "Running" is the local host's `listSessions()` read at click time, never the
  store: hydration refills `ptyIdsByTabId`/`tab.ptyId` with the remembered id. LIVE, calling window
  only (real app: `resume-center-restore-no-wake.spec.ts`, passing on GEX44 and on Windows at
  `93cadd9c3`). Multi-window: PLANNED.
- **Resume / Resume all** are wake intents. Each wake asks `continuity:admitWake` (main,
  `src/main/continuity/wake-admission.ts`), which reuses `observeDispatchHostResources` +
  `decideDispatchAdmission` against a PROVISIONAL 4 GB free-memory floor
  (`PROVISIONAL_WAKE_FLOOR_BYTES`); admission is a reading, not a reservation. SSH, runtime and WSL
  executors are `executor-unobservable`: Resume all skips them, a chosen Resume proceeds labelled
  "not measured". A row is `running` only when a PTY binds and clears its marker. Resume all wakes
  one at a time, each after the previous bound (event-driven, no timer); the first host-wide refusal
  stops it and **Continue** asks again over the same plan. Orphaned agents (tab gone) are listed and
  resume through the canonical sleeping-agent resume filtered by `onlyPaneKeys`. LIVE (real app:
  `resume-center-resume.spec.ts`, GEX44). Per-session wake cost: UNMEASURED (needs a real provider).
- **Window membership** is `bound(windowId)` or `unattributed`. It is never inferred from the
  profile-global active worktree. PLANNED.
- **Previews** render durable history in a main-process `HeadlessEmulator`. The source is
  `daemon-history`, `session-ref`, `sealed-working-set` or `none`, loaded on expand, never labelled
  live, and never resizing or focusing a terminal. The workspace thumbnail is composed from these
  previews, not screen-captured. LIVE for `daemon-history` (real app, local panes:
  `tests/e2e/resume-center.spec.ts`); `session-ref` unit-tested only, not yet run against a real
  remote; `sealed-working-set` PLANNED.
- **Desk snapshots** are sealed records of window placement plus one Working Set per workspace.
  They restore the terminal rail and window placement only, and the UI says so: editors, browser
  tabs and split geometry are not restored. Each member reports its own outcome
  (`applied | already-applied | target-not-empty | owned-by-window | failed`), and a desk is
  restored only when every member is. Retention is bounded, and deletion removes the record before
  any member no other record references. PLANNED.
- **Cursor** is shown per workspace, not per window, because Cursor exposes no window identity.
  Events arrive through the existing Cursor hook service's authenticated endpoint, and every field
  is untrusted. "Open in Cursor" is offered only for a root that canonicalizes to an existing
  directory Orca knows, and is launched with an argv (no shell). Exact conversation resume in
  Cursor is UNSUPPORTED (undocumented). Claude Code sessions run inside Cursor resume in Orca
  through the collision gate, one row per session. Remote-SSH and WSL Cursor are UNSUPPORTED.
  PLANNED.
