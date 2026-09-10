# Terminal Preview Observers

Orca can show a terminal without switching into it. This note says where that content comes from,
what an observer may and may not do, and why the Windows taskbar thumbnail is not part of it.

## The source is the main-side model, not the pane

There are two xterm emulators per PTY. The renderer's pane, and a `@xterm/headless` instance in the
**main process** (`src/main/daemon/headless-emulator.ts`) that parses every chunk at ingestion.
`src/main/ipc/pty-hidden-delivery-gate.ts` states the contract: main drops renderer-bound delivery
*after* model ingestion, and reveal restores from the model.

That makes the main-side model the only preview source that is correct when the pane is hidden,
parked, or in a minimized window — it does not depend on the renderer painting. Headless state exists
once a PTY has produced its first byte, and each entry carries an `outputSequence`: the sequence
actually painted into that emulator, which is the only honest basis for a freshness claim.

Consequently: **never build a preview from a second ANSI interpreter or a screen capture.** The model
is already there, it is already current, and it is already serialized through a transport with
byte-ACK flow control and resync coalescing (`src/main/ipc/terminal-preview.ts`).

## Two postures over one read model

The same read model serves two surfaces with different authority, and the difference is the whole
design:

| | Interactive preview (dashboard) | Observer (hover card) |
|---|---|---|
| `terminalPreview.fit` | yes — claims the grid | **never** |
| `terminalPreview.input` | yes | **never** |
| `focus()` | yes | **never** |
| xterm `disableStdin` | no | **yes** |

`terminalPreview.fit` is not cosmetic: it resizes the PTY through the remote-desktop viewer registry,
and the host pane **parks** and later reclaims its geometry. A surface that opens because a pointer
crossed a row must not do that.

`terminal-preview-is-read-only.test.ts` enforces the right-hand column by sweeping the observer
modules, with a positive control per pattern aimed at the module that legitimately uses it. Keep
those controls pointing at real call sites — a matcher aimed at a file that never contained the call
reports a clean pass forever.

Two things that look like authority transfer and are not: `registerRawTerminalViewSubscriber` is
documented "without transferring terminal query authority" and is read by a different counter than
`shouldModelAnswerHiddenPtyQueries`; and `subscribeToTerminalData` is a plain listener add that never
touches the hidden-delivery gate. The raw-subscriber mark does prevent daemon keep-tail **stream
thinning**, which any observer genuinely needs — you cannot observe a thinned stream.

## One subscription per PTY per renderer

Main keys a preview subscription by `(webContents, ptyId)` and disposes the existing one when that
pair connects again. Two observers of one terminal in one window are now ordinary, so the renderer
ref-counts them over a single main-side subscription
(`terminal-preview-subscription-multiplex.ts`). Acknowledge a batch **once**, not once per observer:
main's flow control counts bytes per subscription.

## Absence is a reason, never a blank frame

`resolveTerminalPreviewSubject` returns `available`, `no-pty` (not started / restoring) or
`not-live` (closed). These stay distinct because they want opposite sentences and refreshing helps in
only one of them. Never fall back to another pane of the same tab; a preview that retargets by
convenience is how someone ends up confidently reading the wrong terminal.

## The Windows taskbar is out of scope, and why

Measured against `node_modules/electron/electron.d.ts` at Electron ^43.1.0. The Windows taskbar
surface Electron exposes is `setThumbnailClip`, `setThumbnailToolTip`, `setThumbarButtons`,
`setOverlayIcon`, `setProgressBar`, `setAppDetails`, `flashFrame`. There is **no API to supply a
thumbnail bitmap** — no `Iconic`, no `DwmSet`. `setThumbnailClip` only chooses which region of the
window's own composited surface the shell shows; it cannot make a throttled window paint.

And the window is throttled: `createMainWindow.ts` calls `setBackgroundThrottling(true)` gated to
darwin only and sets no `disable-renderer-backgrounding` switch, so Windows runs at Chromium's
default. `tests/e2e/minimized-window-background-progress.spec.ts` documents the behaviour — a hidden
renderer drops to 1/second immediately and to 1/minute after five minutes hidden.

So a minimized Orca window has nothing fresh for DWM to composite and no supported route to be handed
anything fresher. The three ways out are all consequential — keep minimized renderers painting
(resource and battery cost, and it changes the background-continuity behaviour the 330-second
minimize gate protects), add a native module for the DWM iconic-thumbnail path (a new cross-process
presentation authority), or accept the limit. **Orca accepts the limit.** The in-app preview is
unaffected by it, because it reads the main-side model rather than the compositor.

If this is ever revisited, the decision to re-examine is the *native module*, not the throttling
switch: throttling is what keeps a minimized window cheap, and the existing minimize gate exists
precisely because background behaviour here has been got wrong before.
