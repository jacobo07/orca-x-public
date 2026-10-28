---
phase: 18-availability-state-capabilities-and-a-truthful-host-card
plan: 03
status: complete
subsystem: host card claims gate / phase verification
tags: [gate, host-card, availability, mutant-drill, node-manifest]
requires: [18-01 host-availability model and producer, 18-02 presenter + HOST_CARD_LABELS + card]
provides: [config/host-card-claims.jsonc, check:host-card-claims gate + test, CI step, 18-VERIFICATION.md, 18-NODE-MANIFEST-PROPOSAL.md]
affects: [package.json aggregate check, .github/workflows/pr.yml]
tech-stack:
  added: []
  patterns: [presentation table gate reusing workspace-gate scanners, comment blanking that keeps indices, vocabulary read from the model that fails loudly, scripted mutant drill with planted-line diff proof]
key-files:
  created:
    - config/host-card-claims.jsonc
    - config/scripts/check-host-card-claims.mjs
    - config/scripts/check-host-card-claims.test.mjs
    - .planning/phases/18-availability-state-capabilities-and-a-truthful-host-card/18-VERIFICATION.md
    - .planning/phases/18-availability-state-capabilities-and-a-truthful-host-card/18-NODE-MANIFEST-PROPOSAL.md
  modified:
    - package.json
    - .github/workflows/pr.yml
decisions:
  - "Effect wording in the card is allowed only when an effect control is classified to a scanned host RPC method (stricter than 'an effect action is classified')"
  - "Every power-loss key (power.sleeping/hibernating/powered-off) needs producer + evidence whatever its text; any other key whose text matches POWER_LOSS fails"
  - "Capability names (capability.*, capabilities.unknown) must carry evidence []; their value line carries the claim"
  - "Live status.get leg owed: out/main predates 18-01, and a laptop rebuild is not cheap"
metrics:
  duration: 20m
  completed: 2026-10-27
actuals:
  tokens: 16000
  tasks: 3
  commits: 4
plan_head_before: 6deaac4ba5dd4b8bbcfb4bc7c4dcd973a9b3da12
---

# Phase 18 Plan 03: Host card claims gate, mutant drills and phase verification Summary

`pnpm check:host-card-claims` now fails when the phone's host card can render a power-loss state without a producer
and evidence, or a control without a backend effect. Every one of the 22 `HOST_CARD_LABELS` keys and both card
controls are classified in `config/host-card-claims.jsonc`, against vocabularies read from
`src/shared/host-availability.ts`. Five live mutants were caught and restored. The phase verification is
`human_needed`: the real-device card and a live status.get read are owed.

## Commits

| Task | Commit | Subject |
|---|---|---|
| 1 (tracer) | 855616304 | feat(18-03): tracer host card claims table and gate (G1 coverage, G5 control identity) |
| 2 RED | 6762cbc00 | test(18-03): RED evidence, power-loss and effect rules |
| 2 GREEN | 54a2af764 | feat(18-03): GREEN evidence, power-loss and effect rules; CI runs check:host-card-claims |
| 3 | 70dc19bf6 | docs(18-03): phase verification with mutant drills and the Node Manifest proposal |

`git rev-list --count 6deaac4ba..HEAD` = 4 at SUMMARY time (this SUMMARY's own commit follows).

## Gate outputs

- `pnpm run check:host-card-claims` exit 0:
  `check-host-card-claims: 22 labels classified, 2 controls classified, 589 host RPC methods known, no unevidenced power-loss state, no control without an effect.`
- `pnpm exec vitest run --config config/vitest.config.ts config/scripts/check-host-card-claims.test.mjs`: Task 1 13/13;
  RED 18 failed / 14 passed (32); GREEN 32/32. With `src/shared/host-availability.test.ts`: 2 files, 58/58.
- `pnpm run check:workspace-surface-claims` exit 0: 54 surface files, 36 claim sites, 9 presenter tone maps (no regression).
- `pnpm run check:recurring-work` exit 0: `Recurring-work inventory OK [total=236 ...] debt=0`.
- `oxlint` and `oxfmt` clean on the two new mjs files. The mjs imports `importsOf`, `jsxOpeningTags`,
  `resolveSpecifier`, `stringLiterals` from `./check-workspace-surface-claims.mjs`; a grep for those four
  `function` definitions in the new file returns nothing.
- `.github/workflows/pr.yml`: `check:workspace-surface-claims` at line 127, `check:host-card-claims` at line 132.
- The rpc scan sees `status.get` and not `host.wake` (sanity read: `589 true false`).

## Mutant drills

| Mutant | PLANT_CONFIRMED | CAUGHT | RESTORE_VERIFIED |
|---|---|---|---|
| P18-M0 composer powered-off when not connected | 1 file, 3 insertions | model test exit 1, `26 tests \| 1 failed` | diff-quiet 0, 26/26 |
| P18-M1a `power.unknown` -> `Powered off` | 1 file, +1/-1 | gate exit 1, G3 `must say unknown` + G4 `power-loss text "Powered off" on "power.unknown"` | diff-quiet 0, gate 0 |
| P18-M1b `power.powered-off` with `evidence: []` | 2 files, 2 insertions | gate exit 1, `power-loss label "power.powered-off" has no evidence` | diff-quiet 0, gate 0 |
| P18-M2a Wake Pressable, effect rpc `host.wake` | 2 files, 7 insertions | gate exit 1, `rpc "host.wake" is not a host RPC method` | diff-quiet 0, gate 0 |
| P18-M2b same Pressable, no testID | 1 file, 5 insertions | gate exit 1, `MobileHostCard.tsx:149 Pressable has no literal testID` | diff-quiet 0, gate 0 |

`git status --porcelain -- mobile src config` was empty before and after the drills.

## C:\ox no-write proof

`git -C C:\ox rev-parse HEAD` before and after: `2b9ec2709afadc29ec4bd6a2e2975ce7b9adfa75`. `git -C C:\ox status
--porcelain` before and after: identical bytes (sha256 prefix `5aa26d1404881539`), four ` M` files belonging to
another session. `cmp` printed `PORCELAIN IDENTICAL` and `HEAD IDENTICAL`. C:\ox was only read
(`node-manifest.ts`, `fleet-resource-observation.ts`, `fleet-placement.ts`).

## TDD Gate Compliance

RED commit 6762cbc00 precedes GREEN 54a2af764. RED was 18 failed / 14 passed: the 14 are the 13 Task 1 cases plus the
vocabulary-missing case, which Task 1 already enforced (the G1 suffix rule needs the vocabulary, so the loud failure
was built with it). No failure was invented for it.

## Deviations from Plan

1. **[Rule 2 - Correctness] Stricter effect-wording rule.** Card effect words pass only when an effect control is
   classified to a scanned RPC method, not merely classified. Otherwise P18-M2a's own "Wake host" label would pass.
   Commit 54a2af764.
2. **[Rule 2 - Correctness] Name families must carry no evidence**, and every power-loss key needs producer and
   evidence whatever its text. Both are pinned by twins. Commit 54a2af764.
3. **RPC scan regex** is `define\w*Method({ name: '...' })`, not any `name: '...'`, so schema fields named `name`
   are not counted as methods. It still sees 589 names (floor 20).
4. **Drills planted by a script** (exact single-occurrence replacement, asserted), not by the Edit tool. The checks
   are the same: clean before, planted-line diff proof, caught, restore after the diff was re-read, diff-quiet, rerun.
   The harness's PLANT_CONFIRMED check had two false negatives during development (an anchor-line comparison that
   ignored indentation, then an added-line set that left out a repeated `<Pressable` line). Each of those runs still
   restored every file (porcelain empty afterwards). The recorded table comes from the third, fixed run.
5. **Live status.get leg not run.** `out/main/index.js` (16:54) predates 18-01 (18:01) and has no
   `hostAvailability`. It is owed in 18-VERIFICATION.md with its recipe.
6. **Branch allow-list.** Commits went to `mobile/host-availability`, as in 18-01/18-02 and as the caller directed.
   It is not protected. Nothing was pushed or merged.

## Known Stubs

None.

## Threat Flags

None. The gate reads repo files only. T-18-11..14 are mitigated: floors, the loud vocabulary failure and twins
(T-18-11); clean-before / diff-proof / diff-quiet restores (T-18-12); C:\ox byte-identical (T-18-13); owed legs
listed as owed (T-18-14).

## Self-Check: PASSED

- Files: config/host-card-claims.jsonc, config/scripts/check-host-card-claims.mjs, config/scripts/check-host-card-claims.test.mjs,
  18-VERIFICATION.md, 18-NODE-MANIFEST-PROPOSAL.md present in HEAD 70dc19bf6.
- Commits 855616304, 6762cbc00, 54a2af764, 70dc19bf6 are in `git log 6deaac4ba..HEAD` (count 4).
