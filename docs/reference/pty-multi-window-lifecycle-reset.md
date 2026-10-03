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

## Out of scope (debt, recorded)

Delivery accounting and the dispatcher-ready gate stay process-wide: a reload of one window still
holds sends for all windows until that page handshakes (C5 makes that the reloading page's own
handshake, not the watchdog), and the reset clears pending bytes for *every* PTY, including ones a
surviving window shows. Making the gate per window is a separate change.

Two more registries are still newest-window-only and are not changed here: the hidden-delivery gate
reset (`rendererGateReset*`, `did-finish-load` + `render-process-gone`) and the orphan-sweep
`did-finish-load` handler. Both move to the newest window on each registration.

The real-app oracle was itself blind: `probeDirectWrite` substring-matches `echo MARKER`, so the
echoed command satisfied it, and its Ctrl+C prefix made bash drop the first byte (`cho MARKER`
ran on GEX44 under a green probe). The survivor test now uses `probeDirectWriteOutput` (a line
exactly equal to the marker). 60 other e2e files still match terminal text by substring; any that
claim "the terminal is alive" from it are unproven (debt).

## Acceptance

- RED unit tests in `src/main/ipc/pty-multi-window-lifecycle-reset.test.ts`, each failing on the
  pre-fix code for the reason named: C1 (output after a second window opens is foreground), C2
  (the first window's listeners are not removed), C3 (a reset of the second window leaves the first
  window's terminal foreground), C3-negative (a terminal only the dead window showed goes background).
- Every existing `pty-*.test.ts` passes unmodified (C4).
- Mutants: registration reset restored; claims cleared globally instead of per window; listeners
  moved instead of kept — each turns a named test red.
- Real app, GEX44: `force-reload-renderer-replacement.spec.ts` 3/3, including `:307`.

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
- Real app: PENDING.
