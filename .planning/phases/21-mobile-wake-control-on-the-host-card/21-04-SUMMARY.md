---
phase: 21-mobile-wake-control-on-the-host-card
plan: 04
subsystem: mobile host card
status: complete
tags: [mobile, host-card, wake, presenter, claims-gate, gex44]
requires: [21-02 composeHostWakeRoute, 21-03 G5 scope and G7 wake, src/shared/host-wake.ts composeWakeProgress]
provides:
  - 19 wake.* labels in HOST_CARD_LABELS (41 total)
  - presentHostCardWake, HostCardWakeInputs, HostCardWakeAttempt, HostCardWakeProjection
  - mobile/src/components/host-card-wake-stage.ts (rebaseBrokerStages, targetAnswerAfterPress, furthestWakeStage)
  - host-card-wake Pressable and host-card-request-stage line on MobileHostCard (props wake, onWake)
  - jsonc classification of the wake labels and the host-card-wake effect (rpc host.wake.request)
  - success line pinned at 41 labels / 3 controls
affects: [21-05 feeds wake/onWake from the session and index.tsx, 21-06 mutants M1 scope, Woken, no-binding, ambiguous]
tech-stack:
  added: []
  patterns: [one presenter table for every word, closed refusal map typed against the shared code list, broker stages rebased to the phone-observed reply, evidence-order rank]
key-files:
  created:
    - mobile/src/components/host-card-wake-stage.ts
  modified:
    - mobile/src/components/host-availability-presentation.ts
    - mobile/src/components/host-availability-presentation.test.ts
    - mobile/src/components/MobileHostCard.tsx
    - mobile/src/components/MobileHostCard.test.tsx
    - config/host-card-claims.jsonc
    - config/scripts/host-capability-producer-gate.test.mjs
    - config/scripts/host-card-effect-claims.test.mjs
    - docs/reference/host-wake-broker.md
    - .planning/STATE.md
    - .planning/phases/20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4/20-VERIFICATION.md
decisions:
  - "The refusal map is Record<Exclude<HostWakeRefusalCode, 'host_key_unavailable'>, label>: a code the shared list gains fails mobile tsc until it has a label; host_key_unavailable is the Owner CLI's passthrough and reads wake.unknown on the phone"
  - "The stage shown is the furthest by a fixed evidence rank (requested < authorized < packet-send-failed < packet-sent < host-announced < runtime-ready), never the broker's array order"
  - "Only broker records with a finite observedAt are rebased; a record the broker sent without a time stays unreadable"
  - "The target answer counts only when its result is a record, lastConnectedAt > pressedAt, observedAt >= lastConnectedAt and observedAt > repliedAt"
  - "Wake button pressed state is borderSubtle: the plan's fill is already bgRaised, so the actions button's bgRaised pressed state would show no change"
  - "Card identifiers avoid the word wake (request, onRequest, showRequestControl, requestButton) so no card copy outside the Pressable can trip G5"
metrics:
  duration: "~16 min (16:11 to 16:27)"
  completed: 2026-10-28
  tasks: 3
  files: 11
estimate:
  tokens: 125000
actuals:
  tokens: 9023        # chars/4 over the added lines of BASE..HEAD (36092 chars), before this SUMMARY commit
  tasks: 3
  commits: 4
plan_head_before: aaeef6c9b1d57f5c89c409fe8290c7ca521bf9ce
---

# Phase 21 Plan 04: Wake control and wake stages on the host card Summary

The host card now draws a `host-card-wake` Pressable beside `host-card-open`, never inside it. It appears only when
`composeHostWakeRoute` returns send for the card's host and the host's own answer does not read awake. A press calls
`onWake` once, with no confirm dialog; while the request is in flight the control is busy and disabled. A
`host-card-request-stage` line shows the wake's evidence from 19 `wake.*` labels in the one presenter table. Broker
stages are rebased to the phone's reply time. "Host answered after wake" and "Orca runtime ready after wake" come only
from the target's own status answer, on a connection made after the press and observed after the reply. Each refusal
code shows its own label, and anything unlisted reads "Wake status unknown". `check:host-card-claims` classifies the
control as `effect` `host.wake.request` and the 19 labels with their observer. Its line is pinned at 41 labels / 3
controls.

Evidence label: **UNIT (GEX44 disposable root)** for the presenter and card render. The card receives `wake`/`onWake`
as props. The session wiring that feeds them is 21-05, and the phone leg is owed.

## Commits

| Task | Commit | Subject |
|---|---|---|
| 1 RED | 4adcea399 | test(21-04): RED Wake control on the host card |
| 1 GREEN | 2611b6314 | feat(21-04): Wake control on the host card from a bound broker route |
| 2 | 4bd7fe411 | test(21-04): wake stage presenter rule table, first-run pass, mutants caught |
| 3 | b08379286 | docs(21-04): notes quote the 41-label, 3-control claims gate line |

BASE (HEAD before the first commit) = `aaeef6c9b1d57f5c89c409fe8290c7ca521bf9ce`. Task 3:
`git show --stat --format= b08379286` names only `.planning/STATE.md`, `20-VERIFICATION.md` and
`docs/reference/host-wake-broker.md` (3 files, 39+/5-). The reference note is tracked with `git add -f` (docs/** is
ignored).

## Gate line

`pnpm run check:host-card-claims` exit 0 (laptop, after 2611b6314 and again after b08379286):

```
check-host-card-claims: 41 labels classified, 3 controls classified, 600 host RPC methods known, no unevidenced power-loss state, no control without an effect, 6 capability producers classified, 3 capability emitters scanned.
```

This is the plan's exact line. The RPC count 600 is unchanged from 21-01. The pin in
`config/scripts/host-capability-producer-gate.test.mjs` asserts it with `toEqual`. Laptop:
`vitest run --config config/vitest.config.ts` over host-capability-producer-gate, host-card-effect-claims and
check-host-card-claims: `Test Files  3 passed (3)`, `Tests  95 passed (95)`.

## GEX44 runs

All runs used host kobicraft-gex44, node v24.21.0, pnpm 12.15.0 and the phase 18 runner unchanged. Each root was
`/tmp/orca-phone-p18-<UTC ts>`, the runner's own naming. Every run printed `TEARDOWN procs=0 root=absent` and the
laptop-side `PROOF ROOT_ABSENT_CONFIRMED`.

| Run | Root | Result |
|---|---|---|
| T1 RED (test) | /tmp/orca-phone-p18-20261028T151235Z | `RUNNER vitest_rc=1`, `RUNNER result=FAIL`: 3 failed, 12 passed. The three rows (one control + press, busy, packet sent) found no `host-card-wake`. The two no-control rows pass on the first run, as absence rows do before the control exists |
| T1 GREEN (test) | /tmp/orca-phone-p18-20261028T151853Z | `RUNNER vitest_rc=0`, `RUNNER result=PASS`, 15/15, `LOCAL exit=0` |
| T2 rows (test) | /tmp/orca-phone-p18-20261028T152224Z | 71/71 on the first run (see TDD notes) |
| T2 mutants A (test) | (runner root, torn down) | 4 failed / 67 passed: M5 powerAwake ignored (route row), M3 array order (evidence-order row), M1 no rebasing (both skew rows) |
| T2 mutants B (test) | (runner root, torn down) | 13 failed / 58 passed: M2 connection-after-press rule dropped (2 rows), M4 refusals not warning (11 rows) |
| T2 full gate | /tmp/orca-phone-p18-20261028T152515Z | see below |
| Regression (test, HEAD b08379286) | /tmp/orca-phone-p18-20261028T152859Z | 3 files (presenter test, both card tests), 102/102, `RUNNER result=PASS` |

Full gate (Mode full; synced: presenter, host-card-wake-stage.ts, presenter test, card, card test):

```
RUNNER vitest_rc=0                     (2 files, 86/86)
RUNNER oxlint_rc=0 oxfmt_rc=0 tsc_rc=2
RUNNER tsc_errors_total=3 tsc_errors_preexisting=3 tsc_errors_touched=0
RUNNER result=PASS
TEARDOWN procs=0 root=absent
PROOF ROOT_ABSENT_CONFIRMED
LOCAL exit=0
```

These are the three pre-existing tsc errors (18-02-SUMMARY), unchanged. None is in this plan's files, and none names
`src/shared/`:
- `src/components/pr-sidebar/MermaidDiagram.tsx(5,35)` TS2307 (generated engine absent)
- `src/terminal/terminal-webview-html.ts(7,51)` TS2307 (generated engine absent)
- `src/workspace/mobile-workspace-client.ts(142,69)` TS2366

The mutant runs recorded their roots in the log files, not here. Both printed the TEARDOWN and PROOF lines, and the
mutated sources were restored from HEAD (`RESTORE_VERIFIED_EXIT=0` for both sets).

## TDD notes

- Task 1: RED (4adcea399) then GREEN (2611b6314). Task 1 was a tracer. Its `<verify>` (gate, the three config test
  files, the GEX44 test run) was re-run end to end after GREEN and passed before Task 2 started.
- Task 2: the plan's Task 1 GREEN action had to implement every Task 2 rule in full (refusal table, rebasing, the
  target answer rule, the last stage). So all 56 new rows passed on their first run, and none was RED. No failure was
  invented, and the commit is not titled RED. Discrimination was proven with five uncommitted mutants in two GEX44
  runs, each restored from HEAD:
  - M1 no rebasing: CAUGHT by the one-hour-ahead row.
  - M2 connection-after-press rule dropped: CAUGHT, 2 rows.
  - M3 array order instead of rank: CAUGHT by the evidence-order row.
  - M4 refusals not warning: CAUGHT, 11 rows.
  - M5 powerAwake ignored: CAUGHT by the route row.
  - The one-hour-behind row alone does not discriminate M1. A broker clock that runs behind cannot fake
    host-announced, because the target answer must already postdate the phone's reply. The behind row also failed
    under M1, but only through its shared ahead assertion.
- No Task 2 GREEN commit was needed: no presenter change.

## Rows

- `MobileHostCard.test.tsx` has 5 new rows. Exactly one `host-card-wake` appears, and the Pressable order is open,
  wake, actions. The control is not under `host-card-open`, and `onPress` calls `onWake` once. A missing entry hostKey
  gives 0 controls. A current awake answer gives 0 controls (`Awake · Orca runtime ready`). In flight, the control is
  `disabled` with `accessibilityState {busy:true, disabled:true}` and there is no stage line. After packet-sent, the
  stage reads `Wake packet sent`, the button reads `Wake`, neither matches `/\b(?:woken|awake|on)\b/i`, and the open
  label speaks the stage.
- `host-availability-presentation.test.ts` has 18 new `it`/`it.each` blocks, 43 cases, each naming its rule:
  - route;
  - broker stages: sent, failed, evidence order, and 5 unreadable shapes including a broker writing target stages;
  - target evidence: announced, ready;
  - 7 before-the-press shapes;
  - clock skew ahead and behind;
  - the eleven phone refusal codes;
  - 5 unlisted codes (`wake_new_reason`, `host_key_unavailable`, empty, `wake.unknown`, `toString`);
  - a refusal outranks stages;
  - in flight;
  - ambiguity, and no stage without an attempt;
  - the text law over 17 broker- and phone-observed labels;
  - the table, 41 keys with 19 `wake.*`.
- Counted lines (non-blank, non-comment) are under the caps, with no max-lines disable and `mobile/.oxlintrc.json`
  untouched:
  - presenter 285 of the .ts cap 300;
  - host-card-wake-stage.ts 55;
  - card 264 of the .tsx cap 400;
  - card test 299 of the test cap 800.
- `Select-String -Path mobile/src/components/MobileHostCard.tsx -Pattern "from '.*wake"` has no match. The card
  imports wake types and `presentHostCardWake` only through `./host-availability-presentation`.
- Laptop after 2611b6314: `pnpm run typecheck:node`, `pnpm run typecheck:cli` and
  `pnpm exec tsc --noEmit -p config/tsconfig.tc.web.json` all exit 0.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The 21-03 non-vacuity row assumed a card with no wake labels**
- **Found during:** Task 1 verification (`host-card-effect-claims.test.mjs`, "main fails on a copy of the real config
  without wakeModel").
- **Issue:** The row expected exactly one failure line naming wakeModel. Now that the real card has 19 wake labels,
  dropping wakeModel also triggers G7 non-vacuity: `19 wake label(s) but no wake vocabulary ... set wakeModel`. That
  is two lines.
- **Fix:** The row asserts both lines, in order, with `toEqual`. That is stricter than the length check. The file was
  not in the plan's list.
- **Files modified:** config/scripts/host-card-effect-claims.test.mjs. **Commit:** 2611b6314.

**2. [Plan option taken] Stage helpers in host-card-wake-stage.ts**
- The plan allows this when the presenter would pass 300 lines. With the helpers inline the presenter was projected
  past 300; with them moved out it is 285. HOST_CARD_LABELS, presentHostCardWake and the imports of every label
  producer module (`host-wake.ts`, `host-wake-proxy.ts`) stay in the presenter.

**3. [Process] Formatter left a stale index after 3 of 4 commits**
- After 4adcea399, 2611b6314 and 4bd7fe411, lint-staged left the index differing from HEAD while the working tree
  equalled HEAD (`diff HEAD --ignore-cr-at-eol --quiet` = 0).
- Only the index entries were reset. One line-ending-only dirty file (the presenter, after 2611b6314) was restored
  from HEAD.
- `diff --cached --quiet` = 0 after each commit.

**4. [Style] Wake button pressed state**
- The fill is `colors.bgRaised`, as planned. The pressed state is `colors.borderSubtle`, one surface tier up, because
  a bgRaised pressed state on a bgRaised fill would show no change. No new colour or size.

### Not changed (out of this plan's files)

- `src/shared/host-wake-proxy.ts:49` still says composeWakeProxyAvailability has "No UI consumer until the deferred
  mobile Wake control". The card now renders the route only in tests, and the session wiring is 21-05. Left for 21-05
  or 21-06, which own the wiring and the close.

## Known Stubs

None. `wake` and `onWake` are optional props, and no caller passes them yet. 21-05 wires them from the session in
`index.tsx` by plan. Until then the card renders exactly as before. The existing card rows pass unchanged: the 16
rows in `MobileHostCard.test.ts` and the original 10 in `MobileHostCard.test.tsx`. That is the regression run at HEAD
b08379286 (/tmp/orca-phone-p18-20261028T152859Z): 3 files, 102/102, `RUNNER result=PASS`,
`TEARDOWN procs=0 root=absent`, `PROOF ROOT_ABSENT_CONFIRMED`.

## Threat Flags

None beyond the plan's register:
- T-21-16: render rows for unbound and awake, mutant M5.
- T-21-17: ambiguity row.
- T-21-18: rebasing (M1), the target rule (M2, 7 before-the-press rows), the text law, and a broker writing target
  stages reading unknown.
- T-21-19: host-card-wake classified effect host.wake.request, gate line 3 controls.
- T-21-20: the card sees no MAC. Its props carry `targetId`, never a MAC.

## Self-Check: PASSED

- FOUND: mobile/src/components/host-card-wake-stage.ts and the 10 modified files in HEAD b08379286.
- FOUND commits: 4adcea399, 2611b6314, 4bd7fe411, b08379286 (`git rev-list --count aaeef6c9b..HEAD` = 4).
