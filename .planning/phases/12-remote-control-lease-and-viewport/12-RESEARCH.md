# Phase 12 research: remote input control and streaming viewport (2026-10-27, read-only scan)

Two read-only agents mapped the code at local HEAD 34b68a06b. Line numbers are as of that commit.

## Input authority (lane A)

The owner is `OrcaRuntimeService.currentDriver: Map<ptyId, idle | desktop | mobile{clientId}>` (`src/main/runtime/orca-runtime.ts:3357`, type in `src/shared/runtime-types.ts`, design doc `docs/mobile-presence-lock.md`). Control is held per PTY, not globally.

**The phone acquires control with no desktop step.** It becomes the driver when it:
- subscribes (`orca-runtime.ts:16358`, or within the grace window `:16257`);
- sends input (`beginMobileInputFloor` `:15501-15522`, committed by `mobileTookFloor` `:15585-15620`);
- calls `setDisplayMode` other than desktop (`terminal.ts:1602`);
- updates its viewport (`:15665`).

`terminal.send` never refuses a mobile client (`isTerminalInputLockedForClient`, `terminal.ts:285-298`). Nothing on the phone or the host waits for a desktop click.

**Generation.** The driver has none. In-flight phone input claims carry a per-PTY generation (`mobileInputFloorClaims`, commit ignores older claims, rollback restores the baseline).

**Release.**
- When the phone unsubscribes, control passes to the most recent remaining phone (`:16425-16437`).
- When the last phone leaves, control goes `idle` after a 250 ms grace (`:16441-16462`).
- On a connection drop, control goes `idle` at once (`:14815-14913`).
- On PTY exit, the entry is deleted (`:15095`).
- A live subscription never expires.

**Desktop reclaim.** `reclaimTerminalForDesktop` (`:15708-15774`) runs from IPC `runtime:restoreTerminalFit` (`src/main/ipc/runtime.ts:114-155`) or RPC `terminal.restoreFit` (`terminal.ts:1610`). The next phone keystroke takes control back, by design, non-sticky.

**Desktop keyboard while the phone drives.**
- The renderer drops it in `pty-connection.ts` `onData` (`:4150-4156`).
- Main refuses it in `src/main/ipc/pty.ts:7436-7461`.
- RPC `terminal.send` from a desktop client is checked before the write (`terminal.ts:1264`, `:1290`).
- GAP: a multi-chunk desktop RPC send without `requireAgentStatus` is not re-checked between chunks (`orca-runtime.ts:18680-18703`).

**The overlay** (`src/renderer/src/components/terminal-pane/MobileDriverOverlay.tsx`) is shown from `TerminalPane.tsx:3385-3416` when the driver is mobile or a mobile fit is held.
- It is a centered `role=dialog` card, but non-modal: `pointer-events-none` outer layer, no scrim.
- On mount it moves focus to "Take back this terminal" if focus was on the body or on this pane's xterm (`mobile-driver-overlay-focus.ts`), so the desktop user's next Enter or Space reclaims the terminal.
- Collapse is local React state only; the chip shows "Phone driving / Take back".

**Tests.**
- Main: `src/main/runtime/mobile-presence-lock.test.ts`, `fit-override-integration`, `mobile-subscribe-integration`, `remote-desktop-driver`, `three-window-independence`.
- RPC: `src/main/runtime/rpc/terminal-send*.test.ts`.
- Renderer: `MobileDriverOverlay.test.tsx`, `mobile-driver-overlay-*.test.ts`, `pty-connection-terminal-input-gating.test.ts`.
- E2E: `tests/e2e/mobile-banner.spec.ts` (faked IPC, not a real phone).

## Streaming viewport (lane C)

**Terminal:** xterm.js in a WebView (`mobile/src/terminal/terminal-webview-html.ts`). Writes never `scrollToBottom`; the live edge is xterm's own (`viewportY >= baseY`).
- H1 (high, keyboard open): every parsed write re-emits keyboard-avoidance metrics computed from the rows ON SCREEN (`terminal-keyboard-avoidance-metrics-injected.ts:17-42`, `html:1123-1127`). When the reader has scrolled back, the bottom rows are full, so the lift jumps to the full keyboard height on the next output chunk. `TerminalPaneView.tsx:71` translates the whole pane up with no animation (`[worktreeId].tsx:3597-3614`, `4307-4311`; `terminal-keyboard-avoidance-lift.ts:9-29`). The existing test pins on-screen tracking (`terminal-keyboard-avoidance-webview.test.ts:114-126`), not the scrolled-back reader.
- H4 (medium-low): a `resized` event without a serialized buffer calls the unanchored `resize()` (`html:804-811`, route `:1558`); `applyTextScale` is unanchored too; `resetZoom` resets `panY` after each `resized`.

**Native chat:** a plain FlatList (`mobile/src/session/MobileNativeChatView.tsx:284-338`). Not inverted. No `maintainVisibleContentPosition` anywhere in `mobile/`.
- The follow state `atBottom` is set only by `onScroll` with an 80 px threshold, and forced true on send.
- H2 (high, long runs): the live window keeps 40 raw messages (`use-mobile-native-chat-session.ts:36` → `boundNativeChatWindow`, `src/shared/native-chat-merge.ts:42-50`). Each new raw message trims the head row, and with no anchoring the reader's text slides up.
- H3 (medium): `contentOffset.y < 60` auto-calls `onLoadEarlier`, which prepends (`View:233-235`, `session.ts:254`).
- Keys are stable transcript ids. The `'streaming'` bubble is swapped for the real id once (one remount).

**Tests:**
- Terminal: `terminal-keyboard-avoidance-*`, `terminal-webview-reflow`, `terminal-viewport-refit`, `terminal-foreground-recovery`.
- Chat: `MobileNativeChatView.test.ts` has no scroll coverage.

## Evidence status
The Owner's video and desktop screenshot did not reach the session or the laptop's Downloads, Videos, Pictures or Desktop (checked 2026-10-27 ~11:00). Not inspected.
