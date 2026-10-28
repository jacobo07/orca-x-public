---
phase: 20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4
plan: 04
subsystem: host-card-claims gate (G6 capability producers) and phase 20 mutant drills
status: complete
tags: [gate, ratchet, capabilities, mutants, D-10, D-09, D-04, D-07]
requires:
  - 20-02 (describeRemoteWakeCapability, host-oob-verdict.ts, host-oob-probe.ts)
  - 20-03 (host-wake-proxy.ts rows K and M, oob-power.ts contract, import sweep, additive pin)
provides:
  - G6 inside check:host-card-claims (config/scripts/host-capability-producer-gate.mjs)
  - hostCapabilities classification of all six HOST_CAPABILITY_IDS in config/host-card-claims.jsonc
  - 20-04-MUTANTS.md (P20-K1, K2, M1, M2, O1, O2, W1, G1, G2, G3)
affects:
  - pnpm check:host-card-claims success line (now ends ", 6 capability producers classified.")
  - 20-05 (verification cites these drills for SC3)
tech-stack:
  added: []
  patterns:
    - "a gate split into a concretely named sibling module, called from the existing entry (no new package script or CI step)"
    - "producer regions: from `function <name>(` to the first column-0 `}`, comments stripped, scanned per region"
key-files:
  created:
    - config/scripts/host-capability-producer-gate.mjs
    - config/scripts/host-capability-producer-gate.test.mjs
    - .planning/phases/20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4/20-04-MUTANTS.md
  modified:
    - config/scripts/check-host-card-claims.mjs
    - config/host-card-claims.jsonc
    - .planning/phases/20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4/20-04-PLAN.md
decisions:
  - "G6 lives in host-capability-producer-gate.mjs and runs from check-host-card-claims.mjs main(); package.json and pr.yml unchanged"
  - "All six ids are classified: can-start-orca (os-probe), can-relay (relay-reported) and can-direct (host-announced) may emit supported; can-wake-lan, can-wake-remote and can-power-on-oob are supported null"
  - "An entry with no supported key fails; absence is not read as null"
  - "producerCount counts resolved producer regions; the floor of six counts classified entries"
  - "Exact success line pinned in the plan acceptance and asserted with toEqual, the RPC count recomputed from rpcMethodsDir"
metrics:
  duration: 17min
  completed: 2026-10-28
  tasks: 3
  files: 6
actuals:
  tokens: 8752
  tasks: 3
  commits: 4
plan_head_before: 8e4d03722e8bfb92a1f4e66febd0368bc680802e
---

# Phase 20 Plan 04: G6 capability-producer ratchet and the phase 20 mutant drills Summary

The existing `check:host-card-claims` gate gained G6. A capability producer may emit `supported` only under an evidence allowance whose kinds it quotes. `can-wake-lan`, `can-wake-remote` and `can-power-on-oob` are pinned to `supported: null`. Ten mutants are caught, covering rows K and M, the OOB boundary, the remote-wake pin and the gate itself.

## What was built

- **`config/scripts/host-capability-producer-gate.mjs`** (pure, no fs). It exports `evaluateCapabilityProducers`, `producerRegion`, `MIN_CAPABILITY_PRODUCERS = 6` and `SUPPORTED_LITERAL`. The rules:
  - R1: the section must exist.
  - R2: every id is classified, no unknown id appears, and there are at least 6 entries.
  - R3: the producer file and its region exist.
  - R4: the region contains a `value:` literal.
  - R5: a supported literal needs an allowance whose evidence kinds are HOST_EVIDENCE_KINDS members, each quoted in the region.
  - R6: a supported allowance on a region that never emits supported is stale and fails.

  Every failure names the id and the producer. 164 non-blank lines, functions under 50 lines.
- **`check-host-card-claims.mjs`**:
  - `stripComments` is now exported.
  - `main` runs G6 after `evaluateHostCardClaims` with the same `read` and `vocab`, and merges the failures into one report and exit code.
  - The header lists `G6 producers`.
  - `evaluateHostCardClaims` kept its signature, and `check-host-card-claims.test.mjs` is unmodified and green.
  - 479 non-blank lines (cap 600).
- **`config/host-card-claims.jsonc`**:
  - A `hostCapabilities` section classifies all six ids, each with a one-line `why`.
  - The header documents the section.
  - The `capability-value.not-supported` why now names the OOB probe.

### Exact success line (plan-check info 3)

```
check-host-card-claims: 22 labels classified, 2 controls classified, 598 host RPC methods known, no unevidenced power-loss state, no control without an effect, 6 capability producers classified.
```

The real-repo test row asserts this line with `toEqual`. Its RPC count is recomputed from `rpcMethodsDir`, so adding a method does not break the row, but any change to the wording or to the 22/2/6 counts does. Labels 22 and controls 2 are unchanged from phase 19.

## TDD record

- **Task 1 RED** (`78d2ecdb6`): `Error: Cannot find module './host-capability-producer-gate.mjs'`, `Test Files 1 failed (1)`, `Tests no tests`.
- **Task 1 GREEN** (`b56b5d666`): 35/35 across the new test and `check-host-card-claims.test.mjs`. The gate prints the line above. oxlint exits 0.
- **Task 2** (`457d44590`): 15 rule-table rows, 18 `it(` rows in total.
  - RED count on first run: 0. All 15 rows passed at once because Task 1 had already implemented R1-R6, which the plan allows ("reported as passing on first run").
  - Passing on first run proves nothing on its own, so each rule's row was shown to fail against a temporarily weakened gate. 13 weakenings were run, each caught by exactly the row it targets: R2-extra, R2-floor, R3-missing, R3-close, R4-floor, R5-member, R5-quoted, R5-empty, R5-dquote, R5-perfile, R6-stale, absent-key and comments.
  - The gate was restored by byte copy (sha256 `018743B4...4C9E` before and after, diff-quiet 0). The driver is `g04-rowproof.ps1` in the job tmp directory.
  - The rows passing on first run were: R2 missing id, R2 extra id, R2 floor, R3 missing file, R3 missing function, R3 no column-0 close, R4 vacuous region with its twin, R5 unknown kind, R5 unquoted kind with its twin, R5 empty list, R5 double quotes, R5 per-region scoping, R6 stale, absent supported key, and commented literals.
- **Task 3** (`725c3e194`): 10 of 10 mutants are PLANT_CONFIRMED, CAUGHT and RESTORE_VERIFIED (see 20-04-MUTANTS.md).
  - P20-M2, O1, W1 and G1 each failed two catchers.
  - After the last restore, `git diff --quiet -- src config mobile` exits 0.

## Verification

- Before every commit: `vitest run` on the gate test, the claims test, the wake-proxy test, the oob-power test and the oob-verdict test passed 104/104 (5 files).
- `pnpm run check:host-card-claims` exits 0.
- oxlint exits 0 on both `.mjs` modules and the test.
- `git diff --quiet HEAD -- package.json .github` exits 0, and nothing under either path changed since `8e4d03722`.
- The Task 3 automated verify passed with `MUTANT_ROWS=10`.

## Deviations from Plan

1. **[Rule 3 - TDD shape] Task 2 had no RED rows.** Task 1's implementation already satisfied every row, so a separate GREEN commit had nothing to change. The commit was named honestly (`test(20-04): G6 rule table, 15 rows green on first run, ...`) instead of `RED G6 rule table`. Evidence that the rows can fail comes from the 13 gate weakenings above.
2. **[Rule 2 - tightening] Two checks beyond R1-R6.** An entry must state `supported` explicitly, and a missing key fails rather than being read as null. Every entry and every allowance needs a `why` of at least 12 characters, matching the labels and actions convention. Both have rows.
3. **[Plan fallback, recorded as directed] P20-G3 field.** The plan first plants `wake` in the jsonc navigation `why`. G5 does not scan that field: it scans the card control's JSX attributes (`check-host-card-claims.mjs:316-317`, `EFFECT_VERB.test(tag.attributes)`). That plant therefore survived (gate exit 0) and was restored. The counted G3 plant is `accessibilityHint="Wake this host"` on the `host-card-open` Pressable in `mobile/src/components/MobileHostCard.tsx:90`, caught by G5 at `:89`.
4. **[Plan-check info 3] Exact success line pinned.** The exact line was added to the Task 1 acceptance in `20-04-PLAN.md`, committed with RED.

## Known Stubs

None.

## Threat Flags

None. G6 is a read-only repo scan and adds no runtime surface. T-20-18 to T-20-21 are mitigated as planned: R5 is drilled by O1 and W1, R1 and R2 by G1 and G2, R3 and R4 by the rule-table rows and their weakenings, and G5 by G3.

## Self-Check: PASSED

- FOUND: `config/scripts/host-capability-producer-gate.mjs`, `config/scripts/host-capability-producer-gate.test.mjs`, `.planning/phases/20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4/20-04-MUTANTS.md`.
- FOUND commits: `78d2ecdb6`, `b56b5d666`, `457d44590`, `725c3e194` (`git rev-list --count 8e4d03722..HEAD` = 4 before this summary's commit).
