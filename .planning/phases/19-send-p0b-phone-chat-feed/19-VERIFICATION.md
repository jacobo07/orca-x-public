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

## Residual (not this phase)
While the phone has no session id, its pending bubble warns "Agent has not shown this message". The agent did show it; the phone could not read it. A `waiting-session` view could say that instead.
