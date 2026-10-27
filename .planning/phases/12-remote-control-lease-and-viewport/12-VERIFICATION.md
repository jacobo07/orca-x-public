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

**Desktop product reality: PASSED 2026-10-27 ~12:40.** `src/main/runtime/desktop-phone-chip.live.test.ts` (052ee178c), SCRIPTED CLIENT.
- **Setup:** the desktop build of d99a86499 ran windowed under xvfb on GEX44 (Linux), with a disposable profile, a completed-onboarding seed, and CDP on loopback.
- **Phone side:** the paired phone-protocol client took the terminal with `terminal.setDisplayMode auto`.
- **Results:**
  - Only the corner chip ("Phone driving · Take back") appeared; `chipIsDialog` was 0.
  - A desktop keystroke opened the explanation card.
  - Focus stayed on `xterm-helper-textarea`.
  - The typed text never reached the PTY.
  - Take back removed the overlay.
- Screenshots `2-chip.png` and `3-explained.png` are in the session scratchpad `p12-chip/`.
- **Why Linux:** a windowed disposable instance on the Owner's laptop exited by itself within seconds, with no error logged. To avoid disturbing the Owner's screen, the leg moved to GEX44.
- **Findings:**
  - A JSON `terminal.subscribe` from a mobile client is refused (`binary_terminal_stream_required`).
  - Mobile input without a stream subscriber is refused (`mobile_input_floor_unavailable`), so the scripted client cannot send as the phone. The real-phone send was proven separately.

**Lease expiry for an observe-only phone: BUILT, not yet proven on the device.** Owner-approved 2026-10-27; spec `12-LEASE-SPEC.md`.
- **Behaviour:** after 2 minutes with no phone action, the next desktop keystroke takes the terminal back. The host decides; it is reached by IPC locally and by RPC on remote hosts.
- **Tests:** all 7 spec acceptance items are covered across:
  - `src/shared/mobile-driver-lease.test.ts`
  - `src/main/runtime/mobile-driver-lease.test.ts`, which drives the real state machine
  - `phone-lease-reclaim.test.ts`
  - the input-gating test
- **Mutants:** P12-L1..L7 all CAUGHT, with byte-exact restore and the suite green afterwards.
- **Gates:** tsc node and web pass; the aperture, variant-parity, recurring-work and max-lines ratchets all pass.
- **Device proof pending:** the scripted client takes control without a stream subscriber, which is exactly the case the lease leaves to Take back. Proving it therefore needs the real phone: subscribe, watch for more than 2 minutes, then type on the desktop.

Not yet done on the input side:
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

## APK native-module gate in CI (2026-10-27)
- `mobile-android-release.yml` audits every built APK before upload and release, so an APK whose JS requires a native module its dex lacks is never published.
- **Defect found while wiring it:** on Node 18 the CLI printed nothing and exited 0, because `import.meta.filename` was undefined and the entry check was false. It now refuses below Node 20.11 (the repo floor is 24).
- **Evidence on GEX44:**
  - On the real release APK (`b0419ff7`, the one on the Owner's phone): 41 native modules, 0 missing, exit 0.
  - On a fake APK: exit 1. On Node 18: refuses with exit 1.
  - The CLI test, added to the 5 tests: P12-G1 CAUGHT, RESTORE_VERIFIED.

## Evidence location
Frames are in the session scratchpad `p12-frames/` (`A`, `B`, `C`, `N` sheets). Owner screenshots containing private content were deleted.
