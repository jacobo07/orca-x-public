---
phase: 18
status: passed
verified: 2026-10-27
residual: device leg OWNER_BOUND (same APK as phase 17; a repeated short message like `hola?` must leave no "Agent has not shown this message")
---

# Phase 18 verification: the delivered-turn echo is not missed

## Finding

An accepted phone chat bubble retired when the number of equal user turns in the loaded transcript reached
`expectedOccurrence = baselineOccurrences + earlierOutstanding + 1`, counted over the WHOLE loaded window. That window is
not stable: `use-mobile-native-chat-session.ts` reads 40 messages and live frames trim its head; paging in history grows it.

- Missed echo (the device symptom): an earlier equal turn (`hola?` in a greeting chat) is counted at send time, then
  slides out of the window as the new turn and its reply arrive. The count stays one short of expected forever, and the
  admission bound turns the bubble "Agent has not shown this message" although the turn exists.
- Premature delivered (found by the control, worse): with no equal turn in the window at send time, paging in history
  that contains an OLD equal turn reached the count and retired the bubble with no echo at all.

The device run itself was not instrumented, so which of the suspects in SEND-P0B-DEVICE-EVIDENCE.md fired on the device is
not observed; the sliding window reproduces the exact symptom deterministically and is a real defect either way.

## Fix

`hasPendingTextEchoLanded` (mobile-native-chat-draft-reconcile.ts): count equal user turns strictly AFTER the send's
captured tail (`baselineTailMessageId`), against `echoOrdinalAfterTail = earlierOutstanding + 1` (an earlier equal send
not yet echoed at capture time echoes after the same tail). The absolute count remains only when the tail id has itself
left the window. The ack-lost path (`findLandedUnconfirmedSends`) already matched after the tail; the accepted path now
agrees with it.

## Tests

- `use-mobile-native-chat-drafts-delivery.test.ts` +2: echo after an equal turn slid out → retired; old equal turn paged
  in before the tail → stays `written`. Both FAIL on the previous sources (GEX44 run, = the mutant "absolute count"),
  both pass with the fix.
- GEX44 /tmp/orca-phone-p17-20261027183915: mobile `src/session` 149 files, 1291 tests pass; mobile tsc 3 errors, the
  same 3 pre-existing.
