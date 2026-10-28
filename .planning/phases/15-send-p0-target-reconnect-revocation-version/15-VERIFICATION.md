---
phase: 15
status: passed
verified: 2026-10-27
residual: every leg here is deterministic or SCRIPTED CLIENT; the real-phone legs are phase 16. The mutant failure text was not retained (logs went with the disposable root), only the CAUGHT exit.
---

# Phase 15 verification: terminal send, wrong target, reconnect, revocation, version

New in this phase: 3e454579f, a refused phone send names why (it also takes the phase 14 residual), plus the
tab-switch binding test.

## Criterion 1: a terminal-runtime send is proven by fresh output on the exact PTY; a second terminal is untouched. PASS (earlier phases)
- Phase 2: `src/main/runtime/rpc/terminal-send-mobile-scope.test.ts` with the fresh-output oracle
  `src/shared/terminal-fresh-output-oracle.ts`; M1-M3 (newest terminal, host ignored, generation ignored) CAUGHT.
- Phase 7 live Windows leg (SCRIPTED CLIENT, the Owner's installed Orca X): FRESH on the target, foreign handle refused.
- Phase 9 two-host leg: per-host FRESH/ABSENT, cross-host handles refused.
No terminal-send code changed in phases 13-15. The chat-send changes touch only `mobile/src/session`.

## Criterion 2: a switch after typing, a stale or deleted session, or a stale lease refuses or binds to the original. PASS
- Draft scope: drafts and pending bubbles are keyed by host+worktree+tab (`mobileNativeChatScopeKey`).
  A draft typed in tab A cannot be sent from tab B ("keeps drafts and accepted pending messages on their
  originating tabs").
- In flight: the handle is captured when Send starts. New test "keeps a send on the terminal it started on
  when the user switches tabs mid-flight". Mutant retarget-on-switch (the body reads the live handle) was CAUGHT.
- A stale or deleted session refuses with `terminal_handle_stale`/`terminal_not_found`/`terminal_gone`
  (phase 2 scope test). The phone now says "Not sent: this terminal closed on the desktop".
- A stale lease or lost floor refuses with `mobile_input_floor_unavailable`. The phone now says "Not sent: the phone
  lost control of this terminal. Reopen it, then send again".
- Host switch: per-host connection, with phase 4 `host-switch-row-isolation.test.ts` (P4-M1..M3 CAUGHT).

## Criterion 3: at most one admitted message across disconnect and reconnect; a revoked device is refused; an older host is not success. PASS
- Disconnected Send: no client → "Message not sent (disconnected)", with no write and no bubble (existing hook path).
- An ack lost or a cutover mid-send gives 'unknown'. There is no retry. The send is held until the
  transcript echo, then says "Delivery unconfirmed" (drafts tests). Phase 3
  `runtime-rpc-mobile-reconnect-revocation.test.ts` covers reconnect identity (M4, M5, M6b, M7 CAUGHT).
- Revocation: phase 3 `assertDeviceStillAuthorized` on frames and RPC. Phase 7 live: the revoked socket
  ends, the token cannot re-auth, and the witness is ABSENT for the revoked nonce.
- An older host without the method answers `method_not_found` → "Not sent: Orca X on the desktop is too old
  for this. Update it". Any code the phone does not know reads as "Message not sent", never as sent.
  (`mobile-native-chat-send-refusal.test.ts`; mutant refusal-swallowed CAUGHT.)

## Criterion 4: Agent send is not gated by the terminal lease; terminal lease semantics are unchanged. PASS
- By design (12-LEASE-SPEC.md): an expired lease only lets the DESKTOP take back control on its next keystroke.
  `terminal.send` never refuses a mobile client on lease grounds (12-VERIFICATION.md:11); a phone send takes the floor again.
- No lease code changed in phases 13-15.

## Gates (GEX44 disposable root /tmp/orca-phone-p15-*, removed)
| Gate | Result |
|---|---|
| mobile `vitest run src/session` | 149/149 files pass |
| mobile `tsc --noEmit` | 3 errors, the same files as baseline 6d2dcc3f4. 0 new |
| oxlint mobile/src/session (laptop) | exit 0 |
| mutants | bundled-clear, delivery-dropped, refusal-swallowed, retarget-on-switch: each PLANT_CONFIRMED / CAUGHT / RESTORE_VERIFIED |
