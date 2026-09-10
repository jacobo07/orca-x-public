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

## The Windows taskbar: what Electron lacks is not what Windows lacks

An earlier version of this note concluded the taskbar was unreachable and that Orca accepted the
limit. **That conclusion was wrong**, and the way it was wrong is worth more than the conclusion: it
read a framework's silence as the platform's answer. The Electron findings below are accurate. The
inference drawn from them was not.

Windows has supplied this capability since Windows 7. An application marks its window with
`DWMWA_HAS_ICONIC_BITMAP` and `DWMWA_FORCE_ICONIC_REPRESENTATION`; DWM then *asks* for a picture
whenever it needs one — `WM_DWMSENDICONICTHUMBNAIL` for the taskbar hover, whose lParam carries the
maximum size it will accept, and `WM_DWMSENDICONICLIVEPREVIEWBITMAP` for Peek, which fires precisely
when an iconic representation is the only one that exists, i.e. when the window is minimized. The app
answers with `DwmSetIconicThumbnail` / `DwmSetIconicLivePreviewBitmap`, and calls
`DwmInvalidateIconicBitmaps` when its content has moved on.

Three properties of that protocol shape any implementation:

- **It is demand-driven.** DWM asks on a cache miss; the app never polls. No timer per terminal.
- **Invalidation is a hint, not a refresh.** Microsoft's own docs warn against calling it frequently,
  and say that under cache pressure DWM may simply not re-request. Taskbar freshness is therefore
  bounded by DWM's willingness to ask, not by how fast Orca can draw — so a freshness claim here has
  to be measured at the shell, not inferred from the update rate.
- **The window must belong to the calling process.** This is stated on the parameter docs of both
  `DwmSetIconicThumbnail` and `DwmInvalidateIconicBitmaps`. It is the decisive constraint: it rules
  out an out-of-process helper, and therefore rules out reusing *every* Windows-native seam Orca has
  (`native/windows-cli-launcher`, `native/computer-use-windows`), all of which are separate
  processes. The calls must run inside the process that owns the `BrowserWindow`.

What Electron gives and withholds, measured against `node_modules/electron/electron.d.ts` at ^43.1.0:
`setThumbnailClip`, `setThumbnailToolTip`, `setThumbarButtons`, `setOverlayIcon`, `setProgressBar`,
`setAppDetails`, `flashFrame` — and no API to supply a thumbnail bitmap. But it *does* expose
`hookWindowMessage` (win32, "called when the message is received in the WndProc") and
`getNativeWindowHandle`, which is the receiving half of the protocol. `electron/electron#42232` asked
for the supplying half by name and was closed as *not planned*. So the gap is a deliberate framework
decision with a documented platform capability underneath it.

`setThumbnailClip` cannot substitute: it selects a region of the window's own composited surface, and
a minimized window has no fresh surface to select from. `createMainWindow.ts` gates
`setBackgroundThrottling(true)` to darwin and sets no renderer-backgrounding switch, so Windows runs
at Chromium's default — `tests/e2e/minimized-window-background-progress.spec.ts` documents a hidden
renderer dropping to 1/second, then 1/minute after five minutes.

The route that follows from all of this is **not** to make minimized renderers paint. It is to take
the visible rows from the main-side headless model — which is correct while minimized precisely
because it never depended on the renderer — rasterize them in the main process, and hand the result
to DWM when DWM asks. That keeps the throttling behaviour the 330-second minimize gate protects.

Still unverified, and not to be assumed: DWM's behaviour under the Windows 11 taskbar (no doc
addresses it either way), what it does with an aspect-ratio mismatch, alpha semantics, and the
numeric message values — Microsoft publishes only the symbolic names, so those come from the SDK
headers. One trap worth naming: an **elevated** process never receives these messages unless it
admits them through the message filter, and the symptom is silence, not an error — the feature would
simply look unimplemented.

Nothing above is shipped yet. The in-app preview does not depend on any of it, because it reads the
main-side model rather than the compositor — which is also why the same model is the right source for
the taskbar if and when that adapter is built.

## Proving a preview, rather than asserting one

`tests/e2e/terminal-hover-preview-reality.spec.ts` opens the card in a running Orca: it splits a
terminal, emits a marker into the pane that is *not* active, hovers that rail row, and checks the
card shows that terminal and that the terminal is unchanged. Geometry is read through `pty.getSize`,
which reports what main **applied** rather than what the renderer asked for — the source sweep can
only show nobody wrote a resize call, and this shows the PTY did not move.

Two habits this suite depends on. A row must carry the identity of its own pane: the hover trigger
originally stamped only the tab id, so two panes of one tab were indistinguishable and the selector
named something that was not the subject. And a run killed by the host is **inconclusive**, never a
failure of the product — on a memory-starved machine this suite dies with empty stdout, no reporter
line and exit -1, and the failure moves earlier as headroom shrinks until globalSetup itself dies
during git seeding. Measure free memory before reading such a run as a verdict.
