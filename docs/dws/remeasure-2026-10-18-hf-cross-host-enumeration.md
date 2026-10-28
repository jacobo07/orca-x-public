# HF cross-host enumeration (row 75), 2026-10-18

Built from `config/dws-completion-matrix.jsonc` rows 56-74 and `tests/e2e/hwf-two-host-*.spec.ts` (23 specs).

| Row | State | Cross-host claim | Live two-host spec |
|---|---|---|---|
| 56 | PASS | host-key pin for SSH targets | precondition of the remote-first run (pin equals ssh-keygen) |
| 57, 58 | PASS | device-local (registry durability, revocation at the effect) | none needed |
| 59 | PASS | remote-first continuity | hwf-two-host-remote-first, hwf-two-host-model-turn |
| 60, 61 | PASS | logical workspace, replica topology | hwf-two-host-replica-topology, -settings-relation, -grouped-relation |
| 62 | PASS | replica state | hwf-two-host-replica-state |
| 63 | PASS | cross-host comparison | hwf-two-host-replica-compare |
| 64 | PASS | dirty-state capsule | hwf-two-host-dirty-capsule (creation leg only; restore/RPC/CLI path not live) |
| 65 | PASS | one-way sync | hwf-two-host-replica-sync |
| 66 | PASS | divergence | hwf-two-host-replica-divergence (primitive only; pair-service/RPC/CLI path not live) |
| 67 | PASS | dirty-both | hwf-two-host-dirty-both |
| 68, 69 | PASS | environment contract, prepare device | hwf-two-host-prepare-device |
| 70 | PASS | continue here | hwf-two-host-continue-here, -ssh, -resume |
| 71 | PASS | SSH targets in fleet | hwf-two-host-ssh-fleet |
| 72 | PASS | jobs placed across hosts | hwf-two-host-mission-placement, -dispatch, -locality, -fanout-environments |
| 73 | PASS | host loss and reconnect | hwf-two-host-host-loss |
| 74 | PASS | mixed relay fails closed | hwf-two-host-mixed-relay |

Result: every HF row that claims a cross-host property has a two-host spec. Rows 64 and 66 are exercised only in part (their own caveats), so row 75 stays PARTIAL.

Method: the table is read from the matrix and the spec directory; this pass did not re-run the specs. The former "owed rows" list in row 75 was stale, since those rows have since passed.