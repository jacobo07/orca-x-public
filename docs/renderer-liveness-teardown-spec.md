# Renderer Liveness at Teardown — Spec of Record

Status: active · Owner: `src/main/window/renderer-liveness-watch.ts` (+ registrar) · Tier: T2

## Problem

`renderer_unresponsive_abandoned` exists for the freeze users report: a stall that never
clears, ended by quitting or restarting. It is emitted when the window goes away while a stall
is outstanding.

Measured with a real Electron 43.1.0 probe: when a window Electron has flagged `unresponsive` is
closed or `destroy()`ed, Electron emits **`responsive` 2–3 ms after teardown starts and 18–22 ms
before `closed`**, while the renderer is still busy (4 runs). The watch treats that as a
recovery. It records `renderer_responsive` and clears the stall, so the abandoned record is never
written. Orca's own frozen-quit path, which vetoes `close` and then calls `destroy()` after
`WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS`, is exactly this shape.

At that `responsive`, `isDestroyed()` is false for both the window and its webContents, so no
documented state distinguishes it from a real recovery.

## Contract

1. A `responsive` during an outstanding stall is held for `RENDERER_RESPONSIVE_SETTLE_MS`
   before it is recorded.
2. If `closed` or `render-process-gone` arrives inside that window, the stall is recorded as
   **abandoned**, measured to the moment the window went away, and no recovery is recorded.
3. Otherwise the recovery is recorded with the timestamp and duration it had when it happened,
   not when it settled.
4. A new `unresponsive` during the settle window commits the held recovery first, because the
   renderer had answered in between.
5. Unchanged: re-emitted `unresponsive` does not re-anchor; a `responsive` with no stall is
   ignored; a healthy window that closes records nothing. The watch stays observation-only, and
   the timer is unref'd so it cannot keep the process alive.

The settle window is 1 s, about 45× the widest measured gap. The cost is that a genuine recovery
record lands a second late, and is lost if the process dies inside that second. The
`unresponsive` record that preceded it is already on disk.

## Acceptance

- RED (watch): unresponsive → responsive → closed within the settle window yields
  `[unresponsive, abandoned]` with no `responsive`.
- RED (registrar): the same sequence through the subscription wiring yields
  `renderer_unresponsive_abandoned` and no `renderer_responsive`.
- Controls: a settled recovery is still recorded with its original time and duration; a pending
  recovery cancelled by teardown never fires later; a second stall commits the first recovery.
- Mutation: recording `responsive` immediately again turns both REDs red.
- Real boundary: an Electron probe driving the real watch through Orca's veto-then-`destroy()`
  shape records abandoned.

## Rollback

Two modules and their tests; no persisted state or wire change. Revert restores the previous
behaviour exactly.
