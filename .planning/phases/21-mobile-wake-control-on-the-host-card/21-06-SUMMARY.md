---
phase: 21-mobile-wake-control-on-the-host-card
plan: 06
subsystem: mobile host card wake, proof and handoff
status: complete
tags: [mutants, verification, human_needed, gex44, host-card, wake]
requires: [21-01 binding, 21-02 composeHostWakeRoute, 21-03 G5 scope + G7 wake, 21-04 card control + presenter, 21-05 session wiring]
provides:
  - .planning/phases/21-mobile-wake-control-on-the-host-card/21-06-MUTANTS.md (seven drills, 19/20 protocol)
  - .planning/phases/21-mobile-wake-control-on-the-host-card/21-VERIFICATION.md (status human_needed, owed list)
  - STATE.md Deferred Verification row 21, Owner summary bind step and phone Wake test, agent resume block
  - 19-VERIFICATION.md D-13 "Closed by phase 21" note
affects: [/gsd-verify-work 21, the owed phone leg]
tech-stack:
  added: []
  patterns: [byte-copy restore with sha256 equality, GEX44 plant via -Sync then one batched restore run, evidence labels per leg]
key-files:
  created:
    - .planning/phases/21-mobile-wake-control-on-the-host-card/21-06-MUTANTS.md
    - .planning/phases/21-mobile-wake-control-on-the-host-card/21-VERIFICATION.md
  modified:
    - .planning/STATE.md
    - .planning/ROADMAP.md
    - .planning/phases/19-wake-on-lan-capability-and-the-lan-wake-broker-m2/19-VERIFICATION.md
    - src/shared/host-wake-proxy.ts (one comment line)
decisions:
  - "P21-S1 plants the whole five-line effect condition as `if (false) {`, so the innermost control always reads as a backed effect; this is the plan's 'made always true' in its smallest single replacement"
  - "P21-B2 keeps isHostKey(entry.hostKey) and replaces only the equality, so the drill isolates wrong-host routing; the no-key no_bound_target rows staying green is expected, not a survivor"
  - "The GEX44 catchers of W1 and B1 were re-run once together, with no -Sync (HEAD bytes only), as their shared RESTORE_VERIFIED run"
  - "21-VERIFICATION.md is human_needed: SC1-SC3 PASS at unit and render level only; the phone leg, steps b and c and the Owner's binding are owed"
metrics:
  duration: "~19 min (15:48 to 16:07 UTC)"
  completed: 2026-10-28
  tasks: 3
  files: 6
estimate:
  tokens: 95000
actuals:
  tokens: 10402       # chars/4 over the added lines of BASE..HEAD (41606 chars), before this SUMMARY commit
  tasks: 3
  commits: 4          # git rev-list --count e30eb1230..HEAD, measured before this SUMMARY commit
plan_head_before: e30eb1230a8023c65e182fc3091d267918e41d79
---

# Phase 21 Plan 06: Mutant drills, verification and handoff Summary

Seven mutants were planted on the real tree. Each was PLANT_CONFIRMED, CAUGHT and RESTORE_VERIFIED by byte copy with
equal sha256:

- R1: the Wake control classified with a non-existent rpc.
- S1: the gate's per-control scope condition made always true.
- S2: `Wake now` inside host-card-open on the real card.
- W1: `Woken` on packet-sent. Caught twice, by the laptop gate and by the GEX44 presenter text law.
- B1: the card drawing Wake without a binding. Caught on GEX44.
- B2: the composer's hostKey equality made always true.
- A1: an ambiguous broker resolved to the first match.

The tree under src, config and mobile was byte-identical after every drill. 21-VERIFICATION.md records phase 21 as
**human_needed**. Routing, presenter and claims gate PASS at UNIT laptop and UNIT GEX44 render level. Owed:

- the phone leg;
- OWNER_BOUND steps b (BIOS) and c (always-on broker node);
- the Owner's binding (`orca wake host-key` on the target, `orca wake target bind` on the broker);
- the Hermes base64 padding residual.

Evidence labels: UNIT laptop, UNIT GEX44, GATE, MUTANT. Nothing is REAL DEVICE, PHYSICAL or emulator.

## Commits

| Task | Commit | Subject |
|---|---|---|
| 1 (tracer) | 18f0d037e | test(21-06): tracer drill P21-R1, Wake rpc mutant caught and restored |
| 2 | 47c86f18b | test(21-06): six more wake mutants caught and restored byte for byte |
| law (comment) | 9ae14b45b | docs(21-06): wake-proxy comment names its phase 21 consumer |
| 3 | 0be26ca2b | docs(21-06): phase 21 verification human_needed, STATE row 21, D-13 closed |

## Mutant verdicts (detail in 21-06-MUTANTS.md)

| Mutant | Catcher | Result |
|---|---|---|
| P21-R1 | `check:host-card-claims` exit 1, `rpc "host.wake.go" is not a host RPC method` | CAUGHT, RESTORE_VERIFIED (sha `E39BE9ED...B63C`) |
| P21-S1 | `host-card-effect-claims.test.mjs` exit 1, 8 failed / 23 passed | CAUGHT, RESTORE_VERIFIED (sha `5EE0D017...E720`) |
| P21-S2 | `check:host-card-claims` exit 1, `MobileHostCard.tsx:155 effect wording "Wake now" ...` | CAUGHT, RESTORE_VERIFIED (sha `A690A402...7761`) |
| P21-W1 | gate exit 1 (W3 `reads "Woken"`) + GEX44 presenter test 2 failed / 69, `RUNNER result=FAIL` | CAUGHT twice, RESTORE_VERIFIED (sha `A001AA53...4C8`) |
| P21-B1 | GEX44 `MobileHostCard.test.tsx` 2 failed / 13, `RUNNER result=FAIL` | CAUGHT, RESTORE_VERIFIED (sha `A690A402...7761`) |
| P21-B2 | `host-wake-proxy.test.ts` 2 other-host rows, 2 failed / 47 | CAUGHT, RESTORE_VERIFIED (sha `52635220...E1C7`) |
| P21-A1 | `host-wake-proxy.test.ts` 2 D-04 rows + reason coverage, 3 failed / 46 | CAUGHT, RESTORE_VERIFIED (sha `52635220...E1C7`) |

GEX44 teardown lines (every run):
- W1 plant, `/tmp/orca-phone-p18-20261028T155530Z`: `RUNNER result=FAIL`, `TEARDOWN procs=0 root=absent`,
  `PROOF ROOT_ABSENT_CONFIRMED`.
- B1 plant, `/tmp/orca-phone-p18-20261028T155613Z`: `RUNNER result=FAIL`, `TEARDOWN procs=0 root=absent`,
  `PROOF ROOT_ABSENT_CONFIRMED`.
- Batched restore run, `/tmp/orca-phone-p18-20261028T155726Z`: `Tests 86 passed (86)`, `RUNNER result=PASS`,
  `TEARDOWN procs=0 root=absent`, `PROOF ROOT_ABSENT_CONFIRMED`, `LOCAL exit=0`.

## Laptop re-run at 9ae14b45b (Task 3)

- Eleven unit files, each in its own vitest run, all exit 0: host-wake-admin 51, rpc host-wake 12, shared host-wake 7,
  wake-broker-store 37, wake-broker 10, cli wake 51, host-wake-proxy 49, host-key-fingerprint 10,
  host-card-effect-claims 31, check-host-card-claims 32, host-capability-producer-gate 32.
- `typecheck:node`, `typecheck:cli` and `tsc -p config/tsconfig.tc.web.json` all exit 0.
- `check:host-card-claims` exits 0 with the pinned 41/3/600 line.
- `check:recurring-work` exits 0, total=236 debt=0.
- `check:durability-contracts` exits 0.
- `git diff --quiet -- src config mobile` exits 0, and `git status --porcelain -- .planning/milestones` is empty.

## Deviations from Plan

### Auto-fixed Issues

**1. [Process] lint-staged reformatted the comment-fix file after the commit**
- **Found during:** commit 9ae14b45b, the comment fix the orchestrator required.
- **Issue:** the pre-commit hook rewrote the CRLF working copy of `src/shared/host-wake-proxy.ts` as LF. The file then
  showed ` M`, although `diff HEAD --ignore-cr-at-eol` was 0 and the index was clean. The hook's own
  backup stash was dropped by the hook, and `git stash list` is empty. This executor never ran `git stash`.
- **Fix:** I restored that one file from HEAD with `git checkout -- src/shared/host-wake-proxy.ts`, as in the 21-05
  precedent. After that, `git diff --quiet -- src config mobile` is 0 and `diff --cached --quiet` is 0.

**2. [Scope] Comment fix outside the plan's files_modified**
- `src/shared/host-wake-proxy.ts:49` still said "No UI consumer until the deferred mobile Wake control". 21-05 left it
  for this plan. The orchestrator law asked for it in its own commit.
- It went into 9ae14b45b, which changes only that comment. typecheck:node, typecheck:cli, tc.web and
  host-wake-proxy.test.ts are green.
- The drills ran at 18f0d037e, before this commit, so their sha256 values describe the pre-comment bytes.

**3. [Observation] P21-B2 caught by the other-host rows, not by every no_bound_target row**
- The plan named "no_bound_target and other-host rows". The plant keeps `isHostKey(entry.hostKey)`, so the rows whose
  entry has no well-formed key stay green.
- The two other-host rows fail, which is the rule this drill guards. It is not a survivor.

### Not run (stated, not claimed)

- The optional SCRIPTED CLIENT leg for host.wake.* with a bound target.
- The phone leg.
- No gsd-tools state handlers were run. STATE.md was edited directly, in the sections the orchestrator named, and the
  history lines were left unchanged.

## Known Stubs

None. This plan adds records and one comment, and changes no behaviour.

## Threat Flags

None beyond the plan's register:
- T-21-27: every verify ran `git diff --quiet -- src config mobile`, with result 0.
- T-21-28: the seven drills cover wrong host, ambiguity, Woken, scope and rpc.
- T-21-29: the labels section exists, the status is human_needed, and no leg is labelled PHYSICAL.
- T-21-30: the record holds no MAC and no device id.

## Self-Check: PASSED

- FOUND: 21-06-MUTANTS.md, 21-VERIFICATION.md, 21-06-SUMMARY.md (this file).
- FOUND commits: 18f0d037e, 47c86f18b, 9ae14b45b, 0be26ca2b (`git rev-list --count e30eb1230..HEAD` = 4 before this
  commit).
- `^status: human_needed$` is present, the STATE row `| 21 | verification_deferred_human |` is present, and the phrase
  "Wake control is DEFERRED under D-13" is absent.
