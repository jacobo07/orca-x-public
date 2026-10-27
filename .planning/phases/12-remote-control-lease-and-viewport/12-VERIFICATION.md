---
phase: 12-remote-control-lease-and-viewport
status: in_progress
verified: 2026-10-27
---

# Phase 12 Verification: remote input control and streaming viewport

## P0-A: does the phone need a desktop click? REJECTED WITH EVIDENCE
A paired phone takes the driver role by subscribing or sending input, with no desktop step.
- Code: `orca-runtime.ts` `beginMobileInputFloor`/`mobileTookFloor`, subscribe at :16358; `terminal.send` never refuses a mobile client (`terminal.ts` `isTerminalInputLockedForClient`).
- Device: on 2026-10-27 the Owner typed into a Claude Code pane from the S25 Ultra without touching the laptop.

The real defects, all fixed:
- **Silent drop.** The desktop met phone control with a centred dialog that moved focus to "Take back", so the next desktop Enter reclaimed the terminal (ping-pong), while desktop keystrokes were dropped silently.
  - e34472537: a new phone driver shows the corner chip. Each dropped desktop keystroke is counted (focus reports excluded) and expands the explanation, without moving focus. Held phone-fit keeps its loud Restore overlay. P12-I2..I6 CAUGHT.
- **Security gap.** An unguarded desktop `terminal.send` checked the lock only before the first chunk.
  - b3eac4866: every chunk rechecks the lock. P12-I1 CAUGHT.

Not yet done on the input side:
- Product reality on the desktop for the chip (renderer change; needs a rebuilt desktop app).
- Lease expiry for an observe-only phone. A live subscription still holds the driver indefinitely; this is by design today and not changed.
- CONTESTED modelling for unsent desktop input.

## P0-B: streaming viewport
**Terminal (xterm WebView).** Characterized stable on the Owner's phone at 11:18 while line output streamed: 8 frames over 11 s each, with the keyboard closed and open. H1 was not reproduced for plain line output.

**Native chat.**
- REPRODUCED 11:19. Scrolled back while messages arrived, the text drifted up about one row per new message, and an auto "load earlier" jumped to older content (12 frames).
- 37b50bce6: `maintainVisibleContentPosition` while off the live edge.
  - Device, APK 94fe1ecf: stable for about 12 s, then a jump once the 40-row window trimmed the anchored row itself.
- ac525502f: the session holds the window head (up to `MAX_MESSAGES`) while the reader is in history, and releases it on return or unmount. P12-S1..S4 CAUGHT; mobile `src/session` 1253/1253.
- **Device, APK b0419ff7 (ac525502f), installed 11:47:10, REAL DEVICE.** Scrolled back in the chat while 10 tool calls (more than 20 raw messages) arrived. All 20 frames were identical across 28.5 s; the previous build jumped at 13.7 s.
  - "↓" returns to the latest message and the button disappears.
  - 0 crashes in Android's crash buffer since 11:47.
  - **Chat viewport: COMPLETE AND PROVEN** for streamed appends and window trimming.
  - Keyboard open/close and foreground/reconnect on the chat surface were not exercised.

## Evidence location
Frames are in the session scratchpad `p12-frames/` (`A`, `B`, `C`, `N` sheets). Owner screenshots containing private content were deleted.
