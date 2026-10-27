# Phase 16: SEND-P0 mutants (criterion 2)

Each row: PLANT_CONFIRMED (the diff was non-empty) → verdict → RESTORE_VERIFIED (`git diff --quiet`). Runs were on GEX44
disposable roots `/tmp/orca-phone-p15-*` and `/tmp/orca-phone-p16-*` (removed), except where marked laptop mirror.
The unmutated baseline passed before every batch.

| # | Brief's mutant | Plant | Verdict | Caught by |
|---|---|---|---|---|
| 1 | send handler skips the RPC | `sendRequest` replaced by a canned accepted reply | CAUGHT | admission test: body write absent |
| 2 | bubble marked delivered on the write receipt | `deliveryByMessageId` left empty | CAUGHT | delivery-evidence + view tests |
| 3 | `\r` dropped | `enter: false` | CAUGHT | send test `enter` is true |
| 4 | wrong host id | (phase 4) host ignored in row isolation | CAUGHT (P4-M1..M3) | host-switch-row-isolation.test.ts |
| 5 | wrong session id | (phase 2) generation/handle ignored | CAUGHT (M1-M3) | terminal-send-mobile-scope.test.ts |
| 6 | refusal swallowed | the refusal message replaced by a bare "Message not sent" | CAUGHT | message-send hook test |
| 7 | lease-lost mapped to success | every reply accepted | CAUGHT | send tests expect 'rejected' |
| 8 | duplicate after reconnect | an ack-lost 'unknown' mapped to 'accepted' (bubble + no hold) | CAUGHT | send test expects 'unknown' |
| 9 | canonical echo shown twice | a pending bubble never retired by its echo | CAUGHT | drafts delivery test |
| 10 | a runtime switch retargets a composed send | the body reads the live handle | CAUGHT | message-send hook test |
| 11 | terminal send hits the newest terminal | (phase 2) newest terminal | CAUGHT (M1) | terminal-send-mobile-scope.test.ts |
| 12 | agent send requires the terminal lease | NOT PLANTED: host lease code, unchanged since phase 12. Its tests (`mobile-driver-lease.test.ts`, `phone-lease-reclaim.test.ts`) pin that only the desktop reclaims | n/a | phase 12 |
| 13 | capability mismatch treated as success | `method_not_found` accepted | first SURVIVED → test added → CAUGHT (laptop mirror) | send test "never treats an older host without terminal.send as a delivered send" |

Also: bundled-clear (phase 14 regression: the `\x15` put back into the body write) was CAUGHT by the phase 13 RED.
