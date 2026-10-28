---
phase: 21-mobile-wake-control-on-the-host-card
plan: 03
subsystem: host-card-claims-gate
status: complete
tags: [claims-gate, wake, effect-scope, observer-rule, D-08]
requires: [21-01 (600 host RPC methods on the real tree), 20-04 G6 sibling precedent, src/shared/host-wake.ts]
provides:
  - config/scripts/host-card-effect-claims.mjs (jsxElements, checkEffectWordingScope, wakeVocabulary, evaluateWakeLabels, checkWakeModel, WOKEN_WORDING, WAKE_TARGET_PRODUCER)
  - G5 scope and G7 wake in check:host-card-claims
  - HOST_WAKE_CARD_STATES in src/shared/host-wake.ts
  - wakeModel in config/host-card-claims.jsonc, observer field documented
affects: [21-04 Wake control and wake labels land into this gate, 21-06 mutants M1 scope and Woken]
tech-stack:
  added: []
  patterns: [pure sibling gate module with helpers passed as parameters, innermost-extent scoping, fail-closed vocabulary]
key-files:
  created:
    - config/scripts/host-card-effect-claims.mjs
    - config/scripts/host-card-effect-claims.test.mjs
  modified:
    - config/scripts/check-host-card-claims.mjs
    - config/host-card-claims.jsonc
    - src/shared/host-wake.ts
decisions:
  - "An extent encloses a copy item when start < index < end - 1: JSX text is indexed at the `>` before it, so text right after an element's last `>` is outside it (the self-closing row)"
  - "An unclosed element covers only its opening tag, so it can legitimize nothing after it"
  - "W3 exempts only a target-stage label whose observer is target; a broker stage mislabelled target still gets the woken-wording check"
  - "targetSuffixes is empty when the wake arrays are missing, so no label may be target and the gate fails closed"
  - "main takes configText as an optional second parameter (default: the real config) so a test drops wakeModel from a copy of the real config without copying the repo"
  - "wakeVocabulary strips comments inside a list before reading members: HOST_WAKE_REFUSAL_CODES carries a comment with an apostrophe that otherwise produced a junk member and lost host_key_unavailable"
metrics:
  duration: "~14 min (15:53 to 16:07)"
  completed: 2026-10-28
  tasks: 3
  files: 5
estimate:
  tokens: 100000
actuals:
  tokens: 7992        # chars/4 over the added lines of BASE..HEAD (31967 chars)
  tasks: 3
  commits: 6
plan_head_before: 0019c813371029937f9e126b2f40f7e0eb663ed3
---

# Phase 21 Plan 03: Per-control effect scope and the wake label family in the claims gate Summary

`check:host-card-claims` now judges effect wording per control. Wording like Wake or Power on passes only when the
innermost control around it is classified `effect` and names a host RPC method that exists. Plan 21-04 adds the first
effect control. Before this plan, that control would have switched the effect-wording check off for the whole card.
The gate also has a `wake` label family and an observer rule. Only the target's own answer, composed by
`composeWakeProgress` with evidence `live-response`, may say the host was announced or its runtime is ready. No other
wake label may read as a woken host.

## What changed

- **G5 scope** (`checkEffectWordingScope`): the card-wide `effectBacked` short-circuit is gone (`effectBacked`: 0 matches
  in check-host-card-claims.mjs). Each EFFECT_VERB copy item (string literals including import specifiers and testIDs,
  JSX text, template literals) is checked against the innermost control extent. Extents come from `jsxElements`, which
  depth-counts same-name openers. The wording passes only if that control is `effect` with an existing `rpc`. An effect
  control nested inside any other control fails with `effect control "<id>" is nested inside "<outer>"`. The failure
  message keeps the prefix `effect wording "<text>" but no effect control`, so the three existing G5 rows pass
  unmodified. checkAction's navigation-attribute check is unchanged.
- **G7 wake**:
  - `wake: 'HOST_WAKE_CARD_VOCABULARY'` is in FAMILY_VOCABULARY. Its suffixes are the union of HOST_WAKE_STAGES,
    HOST_WAKE_REFUSAL_CODES and the new HOST_WAKE_CARD_STATES (`packet-send-failed`, `unknown`, `ambiguous-broker`).
  - `wake` is in CLAIM_FAMILIES, so `wake.unknown` must say unknown and carry no evidence, and every other wake label
    needs evidence.
  - W1: the observer is broker, target or phone.
  - W2: only host-announced and runtime-ready (HOST_WAKE_STAGES minus HOST_WAKE_BROKER_STAGES) may have observer
    target. Those two must have it, with producer `src/shared/host-wake.ts#composeWakeProgress` and evidence exactly
    `["live-response"]`.
  - W3: WOKEN_WORDING (`woken|awake|on|up|ready|running|online|booted`) fails on every other wake label's text.
  - Wake labels without HOST_WAKE_CARD_VOCABULARY fail.
  - `checkWakeModel` fails if `wakeModel` is missing or if any of the four arrays is not found in it.
- **Wiring**: `main` merges `wakeVocabulary(read(config.wakeModel))` into vocab and runs checkWakeModel, merging its
  failures the same way as G6. The header lists `G5 scope` and `G7 wake`. The jsonc gains
  `"wakeModel": "src/shared/host-wake.ts"`, with one header line each for `observer` and `wakeModel`.

## TDD evidence

| Task | RED commit | RED result | GREEN commit | GREEN result |
|---|---|---|---|---|
| 1 | 93f88fc05 | 1 failed, 2 passed: `fails Wake inside host-card-open while host-card-wake is a backed sibling` -> `AssertionError: expected [] to deeply equal [ Array(1) ]` (the card-wide short-circuit silenced it) | d29d8745a | 67/67 over the three gate test files |
| 2 | ae98857bf | 1 failed, 14 passed: `nesting: an effect control inside host-card-open fails even with legitimate text` -> `expected [] to deeply equal [ Array(1) ]`; first-run pass: unbacked, siblings, attributes x2, template x2, imports, self-closing, depth x2, comments (each has a red twin that did produce its failure) | 0e04c10bc | 79/79 |
| 3 | 7b6cddd4b | 16 failed, 15 passed: vocabulary, claim family, non-vacuity, W1, W2 x5, W3 x2, WOKEN_WORDING, wakeVocabulary x2, checkWakeModel, main without wakeModel (`expected undefined to be 'src/shared/host-wake.ts'`) | e6c7b1c90 | 102/102 over the four files incl. src/shared/host-wake.test.ts |

31 `it(` rows in host-card-effect-claims.test.mjs (at least 12 required). check-host-card-claims.test.mjs and
host-capability-producer-gate.test.mjs are unmodified.

## Gates (real tree, after e6c7b1c90)

- `pnpm run check:host-card-claims` exit 0:
  `check-host-card-claims: 22 labels classified, 2 controls classified, 600 host RPC methods known, no unevidenced power-loss state, no control without an effect, 6 capability producers classified, 3 capability emitters scanned.`
  The shape is identical to 20-04's line. The only changed count is RPC 598 -> 600, from 21-01. The success line was not re-pinned (21-04 owns 41/3).
- `pnpm run typecheck:node` exit 0, `pnpm run typecheck:cli` exit 0, `pnpm exec tsc --noEmit -p config/tsconfig.tc.web.json` exit 0.
- `pnpm exec oxlint config/scripts/host-card-effect-claims.mjs config/scripts/check-host-card-claims.mjs` exit 0.
  Counted lines (non-blank, non-comment): check-host-card-claims.mjs 505, host-card-effect-claims.mjs 229,
  host-card-effect-claims.test.mjs 506, check-host-card-claims.test.mjs 479. All are under the 600 `.mjs` cap, with no
  max-lines disable.
- `git diff --quiet 0019c8133..HEAD -- package.json .github mobile` exit 0 (BASE = 0019c813371029937f9e126b2f40f7e0eb663ed3).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Commented member in HOST_WAKE_REFUSAL_CODES**
- **Found during:** Task 3 design (reading src/shared/host-wake.ts).
- **Issue:** The `export const X = [...] as const` member regex that modelVocabulary uses would read
  HOST_WAKE_REFUSAL_CODES wrongly. The apostrophe in the inline comment ("Owner's CLI") pairs with the next quote, so
  the regex returns a junk member and drops `host_key_unavailable`.
- **Fix:** wakeVocabulary strips `//` and `/* */` comments inside the list before it reads members. A row against the
  real host-wake.ts asserts that `host_key_unavailable` is present and that every code matches `^[a-z_]+$`.
- **Files modified:** config/scripts/host-card-effect-claims.mjs. **Commit:** e6c7b1c90.

**2. [Rule 3 - Blocking] main gains an optional configText parameter**
- **Issue:** The test "main on a copy of the real config without wakeModel" needs main to see a modified config. The
  alternative was copying the card, presenter, models, RPC method directory and capability producers into a temp
  root.
- **Fix:** `main(root = process.cwd(), configText = readRepoFile(root, CONFIG_PATH))`. The CLI entry point calls
  main() with no arguments, so its behaviour is unchanged. **Commit:** e6c7b1c90.

**3. [Process] Lint-staged reformatting left a stale index after 4 of 6 commits**
- After commits d29d8745a, ae98857bf and 7b6cddd4b, the pre-commit formatter rewrote the working file to match HEAD
  but left the unformatted version in the index (`MM`). In each case `diff HEAD --ignore-cr-at-eol --quiet` was 0, so
  only the index entry was reset (`git reset -q -- <file>`). `diff --cached --quiet` was 0 afterwards. No content was
  lost.

## Known Stubs

None. The wake family judges 0 labels on the real tree until 21-04 adds the 19 `wake.*` labels. That is the intended
wave order, not a stub. The fixture rows exercise every rule.

## Threat Flags

None. The gate change adds no runtime surface. T-21-12, T-21-13 and T-21-14 are mitigated as planned, and
T-21-15 is accepted.

## Self-Check: PASSED

- FOUND: config/scripts/host-card-effect-claims.mjs, config/scripts/host-card-effect-claims.test.mjs
- FOUND commits: 93f88fc05, d29d8745a, ae98857bf, 0e04c10bc, 7b6cddd4b, e6c7b1c90 (`git log --oneline 0019c8133..HEAD`, 6 commits)
