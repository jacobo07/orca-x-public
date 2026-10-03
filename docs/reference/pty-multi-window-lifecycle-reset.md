---
title: PTY renderer lifecycle reset is per window (D6)
status: live
covers: [d6, pty-delivery, multi-window, renderer-lifecycle-reset, force-reload]
---

# PTY renderer lifecycle reset is per window (D6)

## Problem (measured 2026-10-03)

`registerPtyHandlers` runs once per window. Its first act was
`registerRendererLifecycleResetHandlers(newWindow.webContents)`, which:

1. **ran a full lifecycle reset immediately** — `markRendererPtysHiddenForRendererLifecycleReset()`
   cleared the module-level `visibleRendererPtys` and `activeRendererPtys` for every window, while
   `rendererVisibilityKnownPtys` stayed set. Every terminal of every *other* window became "known
   hidden", so its output went out as `pty:data … background: true` until that window happened to
   report visibility again — which a window that did not reload has no reason to do;
2. **moved the reload/crash/destroy listeners** from the previous window to the new one
   (`clearRendererLifecycleResetHandlers()` first), so a later reload or crash of an earlier window
   reset nothing.

Real app, GEX44: opening a second window stopped the first window's terminal from rendering output
(`force-reload-renderer-replacement.spec.ts:307`, 3/3 on reload-6cd alone and 3/3 merged; the
survivor's last screen shows the echoed command and no output). The reset exists for a page that
died; a page that was merely *joined* by another window has not died.

## Contract

- **C1 — Registering a window resets nothing.** A new window has no claims yet; no other window's
  visibility, activity or delivery accounting changes because a window opened.
- **C2 — Every window keeps its own reset listeners** (`did-start-navigation` main frame,
  `render-process-gone`, `destroyed`) for its whole life. Registering another window never removes
  them; `destroyed` removes that window's own.
- **C3 — A reset is scoped to the window whose page died.** Only the visibility and activity claims
  *that window* made are withdrawn. A terminal another window still shows stays visible; one that
  only the dead window showed fails closed (known hidden) until the new page reports, as before.
- **C4 — Single-window behaviour is unchanged.** One window reloading clears its own claims, which
  are all claims — every existing lifecycle test keeps passing unmodified.
- **C5 — The window whose page reset may reopen the gate.** `pty:rendererDispatcherReady` accepted
  only the newest window's sender, so after an *older* window reloaded (or was Force Reloaded) its
  new page's handshake was ignored and every window's output was held until the 10 s watchdog. A
  handshake is accepted from the newest window or from a window with a pending reset; a straggler
  from a window that was not reset is still refused.

- **C6 — Closing a window never holds the survivors.** `destroyed` withdraws that window's claims
  and resets accounting like a reload, but no page will ever handshake for it: if other windows
  remain and none is mid-reload, the gate reopens at once instead of waiting for the watchdog.
  With one window, behaviour is unchanged (C4).
- **C7 — Every page handshakes at boot** (renderer `main.tsx` → `ensurePtyDispatcher()`). The
  renderer used to handshake lazily, from its first terminal, so a window showing none never
  reopened the gate: GEX44 sampled main after the other window's Force Reload at `ready:false`,
  `forced:0`, pending 136 → 408 chars, then a late watchdog flush. Owner chose the renderer fix
  over a per-window gate in main (2026-10-03). Unhandled chunks are buffered and ACKed instead of
  dropping into a listener-less page.
- **C8 — Gate reset and orphan sweep belong to every window, and marks and holds belong to their
  setter (WR-02).** The hidden-delivery gate records which window set each hidden mark (the last
  `hidden: true` writer; `hidden: false` from anyone clears it) and which windows hold delivery
  interest (any holder suppresses the gate; a window releases only its own hold). The setter is the
  sender's window key, taken main-side from `event.sender.id`, never from the payload; a sender with no
  numeric id is unattributed. Each window's `did-finish-load` and `render-process-gone` run that
  window's gate reset, which withdraws the marks and holds **that window set**, plus the ones whose
  setter is no longer a live renderer, plus unattributed ones (fail closed), plus the entries of PTYs
  whose recorded owner is that window or is no longer live (a closed window never releases its
  ownership; drop memory kept). A live window's entries on an unowned PTY therefore survive another
  window's reload or crash. A window's **first** `did-finish-load` also keeps unattributed unowned
  entries while another live window is registered, because that load is a page starting, not dying
  (C1); with no other live window it clears them, as before. Its `did-finish-load` also runs its local
  orphan sweep (only when it registered on a `LocalPtyProvider`). Registering another window removes
  neither; `destroyed` or re-registration removes the window's own. Both live in the C2 per-window
  lifecycle record. `destroyed` does not run the gate reset: a closed window's PTYs keep their hidden
  marks and interest holds until another window loads (including a newly opened one) or crashes, which
  clears them as dead-setter or dead-owned.

- **C9 — Delivery follows the PTY, not the newest registration (R-05).** The provider data/exit
  listeners and every `pty:*` handler are rebound to the newest `registerPtyHandlers` closure, so
  that closure's `mainWindow.isDestroyed()` read true after the newest window closed and dropped or
  wiped output for every other window's PTY (closing window B stopped window A's terminal from
  receiving output). One resolver, `liveDeliveryWindowFor(ptyId)`, now answers "where does this
  PTY's output go": its live owner (`ptyRendererOwnership`), else the live fallback (the closure's
  window, else the newest live app window), else `null`. `deliveryWindowFor` is that resolver with a
  destroyed last resort so a send still throws into its own catch. Data, batched flush, exit
  (prepare and finalize), serialize request, write-unavailable and the dispatcher-ready watchdog
  resolve per PTY at send time; only `null` (no live renderer window at all) keeps the fail-closed
  wipe (release producers, clear pending and accounting). `pty:modelRestoreNeeded` and
  `pty:requestDeliveryResync` follow the PTY's window too. Left on the newest closure by design:
  the debug-snapshot window fields, write authority (`isPtyWriteEventFromMainWindow`, owner-first),
  `pty:rendererDispatcherReady` (C5) and the per-window orphan sweep (C8).

- **C10 — A heal report judges only the reporter's own PTYs (R-05-H).** `pty:reportRendererDeliveryState`
  with `heal: true` writes off bytes main sent but the renderer never received. Main's delivery
  accounting is process-wide, and a PTY absent from the report read as "received 0", so window A's
  heal report wrote off window B's in-flight bytes and dropped B's pending output. The write-off now
  skips every PTY whose delivery target (`liveDeliveryWindowFor`, C9) is not the reporting sender: a
  PTY another window owns is unknown to the reporter. A report with no identifiable sender is judged
  as the registration window's (the only receiver before multi-window), so it still cannot write off
  another window's PTY. The ACK-silence gate is unchanged.

## Out of scope (debt, recorded)

Unowned PTYs and C3 (WR-02) are closed: see C8 and the WR-02 evidence section below.

Delivery accounting and the dispatcher-ready gate stay process-wide: a reload of one window still
holds sends for all windows until that page handshakes (C5 makes that the reloading page's own
handshake, not the watchdog), and the reset clears pending bytes for *every* PTY, including ones a
surviving window shows. Making the gate per window is a separate change.

The hidden-delivery gate reset and the orphan-sweep `did-finish-load` handler, formerly the last
newest-window single slots, are per window now (C8).

The real-app oracle was itself blind: `probeDirectWrite` substring-matches `echo MARKER`, so the
echoed command satisfied it, and its Ctrl+C prefix made bash drop the first byte (`cho MARKER`
ran on GEX44 under a green probe). The survivor test now uses `probeDirectWriteOutput` (a line
exactly equal to the marker). The remaining substring liveness sites are frozen in
`config/e2e-terminal-liveness-substring-baseline.txt` (31 sites at 5f4fd7257) as a count per file
and probe function, not per site: `pnpm check:e2e-terminal-liveness` fails when a file's count for
a probe function grows, so migrating one site and adding another in the same file and function
passes. The counts only shrink.

## Acceptance

- RED unit tests in `src/main/ipc/pty-multi-window-lifecycle-reset.test.ts`, each failing on the
  pre-fix code for the reason named: C1 (output after a second window opens is foreground), C2
  (the first window's listeners are not removed), C3 (a reset of the second window leaves the first
  window's terminal foreground), C3-negative (a terminal only the dead window showed goes background).
- Every existing `pty-*.test.ts` passes unmodified (C4).
- Mutants: registration reset restored; claims cleared globally instead of per window; listeners
  moved instead of kept — each turns a named test red.
- Real app, GEX44: `force-reload-renderer-replacement.spec.ts` 3/3, including `:307`, and red
  when the boot handshake (C7) is removed.

## Evidence (2026-10-03, Windows)

- `pty-multi-window-lifecycle-reset.test.ts` 7/7 (C1, C2, C3, C3-neg, C5, C5-neg, C6). C2 judges
  listeners by identity across the second registration only, because the gate-reset debt above
  also listens on `render-process-gone`; it then fires the surviving crash listener and requires
  the first window's terminal to go background.
- `src/main/ipc/pty*` 65 files: 589 pass; the 4 reds (Codex account attribution ×2, WSL shim
  PATH, Codex resume provenance) reproduce identically with HEAD's `pty.ts`, so they pre-date D6.
- tsc node 0; oxlint 0 (seeded control: 3 errors, exit 1).
- Mutants, all CAUGHT: registration reset restored (C1, C3, C6); claims cleared globally (C3,
  C6); listeners moved (C2, C5, C6); close does not reopen (C6); reset window's handshake
  refused (C5).
- Real app: see below.

## Evidence (2026-10-03, real app, GEX44 @`1d3e97557`)

Run `/home/kobii/gate8-run-1d3e97557/summary.txt` (14:27–14:30Z, tree clean, build exit 0):

- `force-reload-renderer-replacement.spec.ts` survivor test 3/3 PASS (≈19 s each) with the
  output-line probe; whole spec 3/3 PASS (1.0 min).
- Mutant **no boot handshake** (`main.tsx` `ensurePtyDispatcher()` removed): RED. Main's gate
  sampled `ready:false forced:0 resets:3`, pending 136 → 272 → 408 chars — the pre-fix pattern.
  **C7 is what makes the survivor pass in the real app.**
- Mutant **registration reset restored** (D6 C1): the survivor test still PASSES. The real-app
  spec does not discriminate C1–C6; their proof is the unit suite above. Whether C1 alone was
  ever visible in the real app is unshown.
- Restore: tree clean at `1d3e97557`, rebuild exit 0.
- Superseded for C1/C3 by the closure P1 evidence below.

## Evidence (unit, GEX44 @`af63f4722`)

- `src/main/ipc/pty-per-window-gate-reset-and-orphan-sweep.test.ts` 7/7: tracer (A's reload clears
  its mark after B opened), scope, crash, unowned (fail closed, with an owned control), sweep (A's
  own PTY killed; B's spared while B is live — control: with B read as dead it is killed), destroy,
  re-registration. RED before the fix: tracer `expected true to be false`; sweep `expected "vi.fn()"
  to be called at least once`; destroy left the sweep listener attached; scope red with the
  predicate reverted to "every PTY".
- `src/main/ipc/pty*` filter: baseline @741ca9985 65 files, 612 tests (606 pass, 6 skip, 0 fail);
  after 66 files, 619 tests (613 pass, 6 skip, 0 fail). Failure lists identical (both empty).
  Existing tests unmodified except one C2 comment that recorded this debt.
- tsc node 0; oxlint 0 on touched files.
- Mutants, both CAUGHT (`/home/kobii/closure-runs/p1-01-mutants-af63f4722/summary.txt`), source
  restored with `git diff --quiet` after each:
  - **M1, single slot restored** (registering a window strips every other window's gate-reset and
    sweep listeners): tracer, crash, unowned, sweep red.
  - **M2, global reset restored**: scope, crash, unowned red.
- Unit plane only. No real-app run discriminates C8 yet.

## Evidence (real app, GEX44 @`75ffb11f3`, closure P1)

Plane: **MAIN_STATE**. No user-visible signal discriminates C1: the only renderer consumer of a
background-origin chunk (`meta.background`, `pty-connection.ts` ~7869) acts only when main dropped
output at the pending cap, and the survivor's output round trip is gated by C7, not by claims.

- Main's delivery debug snapshot now reports, per PTY, `visibleClaimWindowIds` /
  `activeClaimWindowIds` (`PtyRendererWindowClaims.claimants`). The survivor test reads its own
  window's claim from its own page (`tests/e2e/helpers/main-pty-window-claims.ts`): a precondition
  that it holds the claim before a second window exists, then one read after the second window
  opens (`D6 C1 [MAIN_STATE]`) and one after that window's renderer is replaced (`D6 C3 [MAIN_STATE]`).
  Keyed on the survivor's window id, never the union `visible` flag.
- Run `/home/kobii/closure-runs/p1-04-oracle-75ffb11f3/summary.txt` (17:25–17:29Z, tree clean,
  build exit 0): survivor test 3/3 PASS (19.2–19.3 s); whole spec 3/3 PASS (1.0 min).
- Mutant **registration reset restored** (gate8's exact anchor, planted once): RED 3/3, each at
  `Error: D6 C1 [MAIN_STATE]: opening a second window withdrew the survivor window's visible claim`.
- Mutant **every window's claims withdrawn on a reset** (C3): RED 1/1 at the same `D6 C1` assertion —
  the new window's first navigation already resets, before the replacement. The `D6 C3` read's own
  red branch is therefore not reached in the real app; C3 alone stays unit-proven.
- Restore: both mutants `RESTORE dirty=0` at `75ffb11f3`, rebuild exit 0.
- An earlier run at `8ed161bb0` (`/home/kobii/closure-runs/p1-04-oracle-8ed161bb0/summary.txt`) went
  red 3/3 at the same line but as a null matcher error: the helper read a missing table row as
  unknown. Main builds the rows from the claim unions, so a missing row under the row cap is no
  claim; fixed in `75ffb11f3` before the run above.

## Evidence (unit, GEX44, review fix WR-01/WR-02 @`9009831b7`)

Logs: `/home/kobii/closure-runs/p1-review-fix/`. Unit plane only (MAIN_STATE via test doubles).

- **WR-01 (dead owner).** New `dead owner` test (did-finish-load and render-process-gone): window A
  owns daemon PTY X with a hidden mark and an interest hold, A is destroyed, then B reloads or
  crashes. RED at `15482c64f`: 2/2 `expected true to be false` (`wr01-red.log`). The scope, crash and
  unowned tests now declare both windows live; the electron mock read every window as dead, which
  the fix would treat as closed. Assertions unchanged. Mutant, predicate reverted to
  `owner === windowKey || owner === null`: the 2 dead-owner tests red (`wr01-mutant.log`).
- **WR-02 (first load).** New `opening` test: a new window's first load keeps an unowned PTY's mark
  and interest that the live first window set, and still clears its own (control). RED at
  `e461af11c`: `expected false to be true` (`wr02-red.log`). New `lone window` test: a first load
  with no other live window still clears unowned leftovers. The `unowned` test now primes one load
  per window, because its subject is a reload. Mutants: no first-load skip makes `opening` red;
  skip without the live-other check makes `lone window` red (`wr02-mutant-*.log`). Each test passes
  run alone (`wr02-isolated-*.log`).
- `src/main/ipc/pty` filter: 67 files, 622 pass, 6 skip, 0 fail (`pty-filter-full.log`). tsc node
  exit 0 (seeded control exit 1, TS2322). oxlint exit 0 on touched files (seeded control exit 1).
- **CR-01 (re-review, headless entry).** `registerHeadlessPtyRuntime` registers a webContents with no
  id, so its lifecycle entry is keyed `undefined`. Electron's `fromId(undefined)` throws. The liveness
  helper now reads any non-integer id as not live, and the headless entry stays registered, because
  C6 counts it. New `headless` test: register headless, then a window, with a mock `fromId` that
  throws on a non-number. RED at `9f6f27830` (`TypeError … conversion failure from undefined`),
  GREEN at `fa205fac0`. The guard-removed mutant goes red. `src/main/ipc/pty` filter: 67 files,
  623 pass, 6 skip, 0 fail. Logs: `/home/kobii/closure-runs/p1-review-fix/iter2/`.

## Evidence (R-05, GEX44, closure P8 plan 01)

Plane: **USER_VISIBLE** (real app) and UNIT. Spec `tests/e2e/window-close-survivor-terminal-output.spec.ts`:
open window B, close B, then a fresh-output probe on a PTY window A owns; a nonce file proves A's PTY
still ran input after the close, so a missing line is a delivery drop.

- RED, `0b3278fb8` (product `d3d85fa63`), `/home/kobii/closure-runs/p8-01-red-0b3278fb8/summary.txt`:
  `R05_RED_REPRODUCED reps=2`, both `Error: R-05 [USER_VISIBLE]: closing the newer window dropped the
  older window's terminal output`; the two-window control before the close passed.
- Unit, `src/main/ipc/pty-multi-window-delivery-owner.test.ts` (8 tests): 7 RED on the pre-fix `pty.ts`
  (data, flush, exit, serialize, write-unavailable, restore routing, resync routing; wrong or no
  recipient), the fail-closed control green before and after. `src/main/ipc/pty` filter 67 files / 623
  tests before, 68 / 631 after, 0 failed in both (`/home/kobii/closure-runs/p8-01-unit/`).
  Mutants M1 (data guard back to `mainWindow.isDestroyed()`) and M2 (restore marker back to
  `mainWindow.webContents`) each turn their named test red; both `RESTORE dirty=0`.
- GREEN, `d34d33584`, `/home/kobii/closure-runs/p8-01-green-d34d33584/summary.txt`: 3/3 PASS, every spec
  `REAP survivors=0`. Real-app mutant M1 (data path guard only): RED at the same `R-05 [USER_VISIBLE]`
  assertion, so the data-path guard alone reproduces the drop in the real app. Restore `dirty=0`, rebuild
  exit 0, neighbour `force-reload-renderer-replacement` 3 passed.
- Residual, unchanged: a closed window's `destroyed` reset still clears pending bytes and delivery
  accounting for every PTY (see "Out of scope"); the unit flush test therefore models the window as
  destroyed before its `destroyed` event is delivered.

## Evidence (unit, GEX44, closure P8 plan 02: WR-02 and R-05-H)

Plane: **UNIT** (MAIN_STATE through test doubles). No real-app oracle discriminates either; none was run.
Logs and mutant diffs: `/home/kobii/closure-runs/p8-02-unit/`.

- **WR-02.** `src/main/ipc/pty-hidden-gate-sender-attribution.test.ts` (7 tests). RED on the unfixed
  tree (`wr02-red.log`): `reload` and `crash` fail on the post-reset assertion that window A's hidden
  marks and its interest hold on an unowned PTY survive window B's reset (`expected false to be true`;
  the same assertions pass before the reset), and `hold ownership` fails (`expected +0 to be 1`: B
  releasing its hold dropped A's). Controls pass both before and after: own marks cleared by their own
  window, a closed window's entries cleared by another window's reload, unattributed entries cleared,
  last writer's unmark clears. Fix `8d0dca3ff`. Mutants (`MUTANT_RESULT` in `summary.txt`, each anchor
  count 1, `RESTORE dirty=0`): W1 reset predicate ignoring the setter turns `reload` and `crash` red; W2
  release dropping every holder turns `hold ownership` red. The per-window suite
  `pty-per-window-gate-reset-and-orphan-sweep.test.ts` is unmodified and green.
- **R-05-H.** `src/main/ipc/pty-delivery-heal-window-scope.test.ts` (3 tests). RED on the unfixed tree
  (`heal-red.log`): A's report naming only its own PTY also wrote off B's PTY (`writtenOff` held both
  ids), and B's report symmetrically; the single-window control passes before and after. Fix
  `92a507665`. Mutant H1 (sender scope removed) turns both two-window tests red, `RESTORE dirty=0`.
  `pty-delivery-health-heal.test.ts` is unmodified and green.
- `src/main/ipc/pty` filter: 68 files / 631 tests before, 69 / 638 after WR-02, 70 / 641 after R-05-H,
  0 failed throughout (`pty-before.json`, `pty-after-wr02.json`, `pty-after-heal.json`, `pty-final.json`).
