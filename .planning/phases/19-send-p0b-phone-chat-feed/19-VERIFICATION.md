---
phase: 19
status: human_needed
date: 2026-10-27
---
# Phase 19: the phone chat shows the host's turns for a phone-started session

## Verdict
This branch does not reproduce the defect. The most likely cause is that Host 1 runs an older Orca X build. Proving it needs one reading that only the Owner can take (see "Owed").

## The path, owner by owner (file:line on this branch)
1. **The phone subscribes only when it has a session id.**
   - `mobile/src/session/use-mobile-native-chat-session.ts:145` returns early when `sessionId` is null, and the status becomes `waiting-session` (:68).
   - That id is `tab.agentStatus.providerSession.id` (`mobile-native-chat-eligibility.ts:62`).
   - The effect depends on `sessionId` and `transcriptPath` (:217), so null→id and id→id both re-subscribe. The phone is not the gap.
2. **The host fills providerSession from the hook row when the renderer's status has none:** `src/main/runtime/orca-runtime.ts:32912-32929`.
   - Landed in 4f00b2118 (#11636, 2026-07-31), an ancestor of HEAD.
   - The headless fallback `buildPtyMobileAgentStatus` (:33150) reads the hook row regardless of PTY status (:33162).
3. **Pane key.** A phone-created tab on a host with a window is created by the renderer (`terminal:requestTabCreate`, :28092). The projection key (:32861) and `getMobileTerminalPaneKey` (:33443) use the same formula. No mismatch.
4. **Transcript.** A transcript file that has not been flushed yet is resolve-polled (`src/main/native-chat/transcript-watch.ts:44-191`, #8401). It is not-watching only for a blank session id or a missing decoder.

## Tests added (orca-runtime.test.ts, `keeps the hook session on a worked pane whose title becomes the …`)
Setup: a working spinner title, then an idle title, with a hook row carrying providerSession. The two variants use `✳ <topic>` (Claude's real idle title) and `<topic>` with no glyph.
- Both are GREEN on HEAD (vitest, laptop, 2026-10-27 19:37).
- **Mutant 1** drops `hookRow.providerSession` in `buildPtyMobileAgentStatus`. Both tests CAUGHT; restore verified (empty diff).
- **Mutant 2** makes the non-agent-title early return unconditional (:33204).
  - The glyph-less variant is CAUGHT, so it reaches that branch, and the code keeps the session today.
  - The `✳` variant passes because that title classifies as agent and never enters the branch.
  - Restore verified.

Candidate 2 from the trace (the early return drops the session) is therefore refuted on this branch for both title shapes.

Not built: a renderer-published-status variant (Test B), because the fixture costs too much for a merge already on HEAD.

## Owed (OWNER_BOUND)
On Host 1 (`C:/Users/User`):
1. Read the installed Orca X version (Settings > About, or the installer name). If it predates 4f00b2118 (2026-07-31), the fix is to update Host 1, with no code change here.
2. If Host 1 is at or after 4f00b2118, repeat device leg 2 and capture the phone's `session.tabs` payload for the new tab. If `agentStatus.providerSession` is absent, the gap is the hook path on Host 1 (hooks installed for that account home?). If it is present, the gap is the transcript stream.

## Reopen (2026-10-27 20:20): Host 1 runs c4679d615, which contains 4f00b2118
"Host 1 is older" is refuted. A static trace of the phone create path against a desktop tab found no key or env gap:
- Phone path: `session.tabs.createTerminal` (activate false for `navigation:'caller'`, `src/shared/runtime-navigation.ts:20-22`) → `terminal:requestTabCreate` source `runtime-session` (orca-runtime.ts:28092) → renderer `useIpcEvents.ts:1749-1870`. The tab is background-mounted at once (`background-terminal-worktree-mount.ts:31-135`). The spawn is not deferred until the tab is viewed.
- Hook env: the renderer sets ORCA_PANE_KEY = `makePaneKey(tabId, leafId)` (pty-connection.ts:1217, 3442-3457). Main re-checks it against the spawn args (src/main/ipc/pty.ts:6427-6518) and injects the hook port and token (pty.ts:1840-1845, 6632-6648). This matches the desktop new-Claude-tab path (launch-agent-in-new-tab.ts:178-206).
- Projection key `makePaneKey(parentTabId, leafId)` (orca-runtime.ts:32861, 33443) matches the hook server's exact lookup (agent-hooks/server.ts:730-733).
- Rescue path (orca-runtime.ts:28147-28168): it reuses the renderer's identity (:28315). `isValidHostTerminalTabId` rejects only web-surface ids (terminal-tab-id.ts:7), so the minted pane key matches (:27359-27367).

Not settled statically, needs a runtime reading:
1. Does Claude's hook post at all for that pane on Host 1? (A folder that is not trusted yet, hooks missing from `C:\Users\User\.claude\settings.json`, or hook ingest gates.)
2. Did the 28152 rescue fire and leave a second PTY? (grep Host 1 logs for "Timed out waiting for terminal surface".)

OWNER DECISION NEEDED: the live repro on this laptop's installed Orca X would pair a scripted client and launch claude.exe under the real account. `autonomy_gate` classifies it OWNER (irreversible). Options:
- (a) The Owner reads, on Host 1, whether `~/.claude/settings.json` carries the Orca hooks and greps the Orca logs for the rescue line.
- (b) The Owner authorizes the scripted live repro on this laptop, with the tab closed and the device revoked afterwards.
- (c) Defer.

Pick: (a), because it is read-only.

## Trigger (2026-10-27 ~22:00, /gsd-autonomous): an Enter swallowed with the paste parks the body
The fourth device leg narrowed it to the phase-17 paste shape. Measured here with a real claude.exe 2.1.312 under
ConPTY and a fake API (evidence/19-paste-enter-harness.cjs; synthetic 4-paragraph 785-char body):
- Hypothesis (a) is refuted. The transcript user line equals the sent text byte for byte (a string, not "[Pasted
  text]"), and the host decoder (`transcript-line-decoders-claude.ts`) takes it as is.
- With the shipped spacing (paste, 1500 ms, Enter) every run submitted. With the Enter in the same batch as the
  paste (0 ms), 5 of 6 runs left the whole body on the input line and the Enter became a trailing newline. That is
  exactly Host 1: "not shown" and no reply. A slow or busy host (Claude still rendering the previous reply, or Stop
  hooks running) reads both writes in one batch even though the phone waited 1500 ms.
- In that state ONE more Enter does nothing (single Enter at +5 s and +8 s: 3 of 4 still parked); a SECOND submits.
  Two more Enters 1.5 s apart: 3 of 3 submitted. At 3 s apart: 3 of 3. The recovered transcript text equals the sent
  text, so the phone's echo matcher retires the bubble.
- Spare Enters on an empty prompt after a normal submit added no user turn (2 of 2).

Not proven: that Host 1's own run hit this race (no screen of Host 1 was captured). It is the only mechanism found
that yields "not shown" plus no reply with working hooks and a working feed.

Fix 0b6cb979a (RED 6f4679f53): after an accepted Enter, `sendMobileNativeChatAgentPrompt` presses Enter
`MOBILE_NATIVE_CHAT_SUBMIT_REPEATS` (2) more times, each `MOBILE_NATIVE_CHAT_PASTE_SETTLE_MS` apart. A refused repeat
stops the repeats and the turn stays accepted. Phone-only, no wire or host change. Cost: the composer's sending
window grows by 3 s.

Gates (GEX44 /tmp/orca-phone-p19-20261027220020, torn down):
- admission file 8/8 GREEN; mobile `src/session` 149 files / 1295 tests pass.
- Mutant REPEATS=0: 4 FAIL (write count 3, expected 5) = CAUGHT. Mutant drop `break`: 1 FAIL = CAUGHT. Restore diff 0.
- mobile tsc: the same 3 pre-existing errors, 0 new.

Owed (OWNER_BOUND): an APK from >= 0b6cb979a on the S25 Ultra, then the same long 4-paragraph message in a phone
tab on Host 1 must become a turn with a reply.

## Residual (not this phase)
While the phone has no session id, its pending bubble warns "Agent has not shown this message". The agent did show it; the phone could not read it. A `waiting-session` view could say that instead.
