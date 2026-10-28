---
phase: 21-mobile-wake-control-on-the-host-card
reviewed: 2026-10-28T00:00:00Z
depth: standard
diff_range: 8858ab60f..HEAD
files_reviewed: 21
files_reviewed_list:
  - src/main/runtime/rpc/methods/host-wake-admin.ts
  - src/main/runtime/runtime-rpc.ts
  - src/main/runtime/wake-broker-host.ts
  - src/main/runtime/wake-broker.ts
  - src/main/runtime/wake-broker-store.ts
  - src/main/runtime/wake-broker-state-schema.ts
  - src/shared/host-wake.ts
  - src/shared/host-wake-proxy.ts
  - src/cli/handlers/wake.ts
  - src/cli/specs/wake.ts
  - src/cli/handler-group-manifest.ts
  - config/durability-contracts.jsonc
  - config/host-card-claims.jsonc
  - config/scripts/check-host-card-claims.mjs
  - config/scripts/host-card-effect-claims.mjs
  - mobile/app/index.tsx
  - mobile/src/components/MobileHostCard.tsx
  - mobile/src/components/host-availability-presentation.ts
  - mobile/src/components/host-card-wake-stage.ts
  - mobile/src/components/use-host-card-wake.ts
  - mobile/src/transport/home-host-wake-session.ts
findings:
  critical: 1
  warning: 4
  info: 2
  total: 7
status: issues_found
fix_status: warnings_fixed
---

# Phase 21: Code Review Report

**Reviewed:** 2026-10-28
**Depth:** standard (callers traced into rpc-client.ts, host-wake.ts RPC methods, wake-broker.ts retention)
**Files Reviewed:** 21
**Status:** issues_found

## Summary

The host side is sound. The new admin verbs are local-only: `adminStore` / `isLocalRpcCaller`, plus the CLI wrapper
`assertWakeRunsOnBroker` (wake.ts:147-160), which wraps every verb, `wake host-key` included. The host key is
read from the server's live `getE2EEPublicKey()`, so it is the same key the phone pairs with. The fingerprint rule
matches on both sides (`fingerprintHostPublicKey` vs `hostKeyFromPublicKeyB64`). `targetsFor` projects only
`targetId`, `label` and `hostKey`. The store enforces one key per broker and refuses the broker's own key. Without
a schema bump the newer-schema rule still holds, because a malformed `hostKey` invalidates the record.

Refusal codes cannot reach `handleAuthRejection`, because rpc-client.ts:527 only matches `unauthorized`. Clock
rebasing is correct: every broker record is placed at `repliedAt`, and `host-announced` needs a target answer
strictly after that. `brokerRecord` drops any broker-written `host-announced`.

The phone path has a blocker: the Wake control can never render against a real broker, because the session
stores the `host.wake.targets` wire object where the composer expects the array. All tests miss it because the
mobile fixtures hand-build the array shape. Four warnings follow:
- a focus re-read overwrites a proven wake with a refusal label;
- a press can sit in `waitForConnected` with no bound;
- a stale binding answer can route a press, and the broker cannot check it;
- the claims gate's wording rules do not reach the presenter or the new stage module.

## Critical Issues

### CR-01: Wake control never renders in production: `host.wake.targets` result object is stored where the composer expects the array

**File:** `mobile/src/transport/home-host-wake-session.ts:85-88` (consumers: `src/shared/host-wake-proxy.ts:67`, `:132`)

**Snippet:**
```ts
const snapshot: HomeHostWakeTargetsSnapshot = {
  observedAt: Date.now(),
  targets: response.result          // wire shape is { targets: [...] }
}
```
```ts
// host-wake-proxy.ts:67
if (!Array.isArray(targets.targets)) { return unknownProxy('targets_unreadable') }
// host-wake-proxy.ts:132
return boundTargetIds(broker.inputs.targets?.targets, hostKey)...
```

**Scenario:**
1. The broker answers `host.wake.targets` with `{ targets: [{ targetId, label, hostKey }] }`. This comes from `targetsFor`, wake-broker.ts:294-303, through the handler at host-wake.ts:39, and host-wake.test.ts:258-263 pins this exact shape.
2. The phone stores `snapshot.targets = { targets: [...] }`, an object.
3. `composeWakeProxyAvailability` then returns `targets_unreadable`, and `boundTargetIds` returns `[]` because `Array.isArray` fails.
4. `composeHostWakeRoute` therefore always returns `no_bound_target`, so `showControl` is always false and `pressHostWake` always returns null.

The SC1/SC2 feature is dead on every real phone, and the card shows nothing.

**Why guards miss it:**
- home-host-wake-session.test.ts:104 and :212 settle `okResponse(BOUND_TARGETS.targets)`, which is the bare array, not the wire object.
- MobileHostCard and presenter tests feed `WakeRouteBroker` inputs that were already unwrapped.
- The composer test (host-wake-proxy.test.ts:125) asserts that an object is "unreadable", so it codifies the failure.
- Only an end-to-end leg would catch this. The SCRIPTED CLIENT leg was left owed (21-06-SUMMARY.md:134), and the phone leg is human_needed.

**Fix:**
```ts
const result = response.result
const snapshot: HomeHostWakeTargetsSnapshot = {
  observedAt: Date.now(),
  // Why unwrap: host.wake.targets answers { targets: [...] }; the composer reads the array.
  targets: isRecord(result) ? result.targets : undefined
}
```
Then fix the fixture so it can fail: settle `okResponse({ targets: BOUND_TARGETS.targets })` and assert the route
becomes `send: true`. Better still, drive one test from a real `createWakeBroker().targetsFor(...)` answer, so
the fixture shape cannot drift from the wire again.

## Warnings

### WR-01: A focus re-read turns a proven wake into "Wake record expired or unknown" (warning tone) and labels post-send status errors as press refusals

**File:** `mobile/src/transport/home-host-wake-session.ts:230-231`, `:247-263`; `mobile/src/components/host-availability-presentation.ts` (`attemptStageLabelId`, refusal checked first)

**Issue:**
- `isWakeAttemptTerminal` only treats a refusal or `packet-send-failed` as terminal. An attempt that reached `packet-sent`, or that the presenter already shows as `host-announced` / `runtime-ready`, is therefore re-read on every focus.
- The broker keeps wake records for only `WAKE_STATUS_RETENTION_MS = 300_000` (wake-broker.ts:14). After that, `host.wake.status` answers `wake_unknown` (wake-broker.ts:286).
- `readHostWakeStatus` writes that code into `refusalCode`, and `attemptStageLabelId` lets `refusalCode` win over every stage.

**Scenario:**
1. The user presses Wake. The host boots and reconnects, and the card shows "Orca runtime ready after wake".
2. The user opens that host's terminal and returns to Home after more than 5 minutes.
3. `refreshWakes` re-reads the wake and gets `wake_unknown`. The card now shows "Wake record expired or unknown" in warning tone.

The phone-observed target evidence is discarded and replaced by a warning.

A status read refused for another reason has the same effect. For example, `wake_device_revoked` after the packet was already sent renders "Wake refused: device revoked", which states that the wake was refused when it was in fact sent.

**Fix:** Keep the press outcome and the status-read outcome apart:
- Add a separate `statusReadCode` that never overrides stages already observed.
- Map `wake_unknown` on a re-read to "stop refreshing, keep furthest stage".
- In `wakesToRefresh`, also skip attempts whose composed progress already includes `host-announced`.

### WR-02: A press can wait unbounded for a broker reconnect, then send a stale wake; the card stays busy for the session

**File:** `mobile/src/transport/home-host-wake-session.ts:168-171` (also `:225`); `mobile/src/components/use-host-card-wake.ts:93`, `:111-112`

**Issue:** `requestHostWake` calls `client.sendRequest('host.wake.request', …)` with no options. In rpc-client.ts:1036, `waitForConnected(options?.timeoutMs)` with `timeoutMs` undefined arms no timer, so a request issued while the client is not `connected` waits until some future reconnect.

The press route uses the React `hostStates` snapshot. It never checks the live state of the broker client it actually sends on (`planHostWakePress` only looks the client up by id).

**Scenario:**
1. The broker's connection drops, for example on a Wi-Fi to cellular hand-off, just before the card re-renders, and the user taps Wake.
2. The attempt shows busy (`repliedAt === null`) and `inFlightRef` holds the host id, so every later tap is a silent no-op.
3. If the broker never comes back, the card is stuck for the session.
4. If it comes back an hour later, the magic packet goes out then, long after the user stopped wanting it.

`refreshWakes` checks `getState() === 'connected'` before re-reading, but the press path does not.

**Fix:**
- Check `plan.client.getState() === 'connected'` in `planHostWakePress`.
- Pass `{ failWhenDisconnected: true }`, or a bounded `timeoutMs`, to both `sendRequest` calls.
- Map "not sent because disconnected" to "no attempt" (clear the pressed record) rather than `unknown`, because nothing reached the broker.

### WR-03: A stale binding answer can route a press to a target that is no longer bound to this card's host key; the broker cannot detect it

**File:** `mobile/src/transport/home-host-wake-session.ts:82-89`, `:168-171`; `src/main/runtime/wake-broker-store.ts` `bindTarget`

**Issue:**
- The phone re-asks `host.wake.targets` only once per new `status.get` answer (`shouldFetchWakeTargets`), and a failed re-read keeps the old answer (line 82).
- The press sends only `{ targetId, requestId }`. The broker's `request` never sees which host key the phone believed the target was bound to.
- So when the Owner corrects a binding with `orca wake target bind <wt_X> --host-key <B>` (it previously named A), a phone that stays on Home keeps routing card A to `wt_X`. That is still "current" because it postdates `lastConnectedAt`.

**Scenario:** The Owner bound `wt_X` to host A by mistake, and its MAC is really host B's. The Owner rebinds it to B. Until a new status answer and a re-fetch, a press on A's card makes the broker wake B. This is exactly the "never guess which target" law. It is bounded and reversible, which is why it is a warning and not critical.

**Fix:**
- Add an optional `hostKey` to the `host.wake.request` params. This is additive: old brokers strip it, per remote-wire-compatibility.
- Have the broker refuse with `wake_target_unknown` when the target's current `hostKey` differs.
- Have the phone always send the card's key.
- Optionally, re-fetch targets on press when the snapshot is older than N seconds.

### WR-04: Claims-gate wording rules do not reach the presenter or the new stage module, so "Woken" or effect wording can escape outside `HOST_CARD_LABELS`

**File:** `config/scripts/check-host-card-claims.mjs:476-499`; `config/scripts/host-card-effect-claims.mjs:20`, `:227-233`

**Issue:**
- W3 (`WOKEN_WORDING`) is applied only to rows of the label table (`evaluateWakeLabels` reads `rows.get(key)?.text`).
- G5 effect wording is applied only to `cardCopy`, which is the literal copy of `MobileHostCard.tsx`.
- The presenter's copy outside the label block (`presenterCopy`) is checked only against `POWER_LOSS`.
- `host-card-wake-stage.ts`, `use-host-card-wake.ts`, `home-host-wake-session.ts`, and any child component the card imports are not scanned at all.

**Scenario:** Two mutations pass the gate:
- `presentHostCardWake` returns `stageText: furthest === 'packet-sent' ? 'Host woken' : …`, a literal outside the label block.
- A `<HostWakeButton/>` component in its own file renders `<Text>Power on</Text>`.

Both reach the card's rendered output. This also answers the focus question: wording can escape through a component outside the scanned card file.

**Fix:**
- Run `EFFECT_VERB` and `WOKEN_WORDING` over `presenterCopy`.
- Require `stageText` to be produced only as `HOST_CARD_LABELS[...]`, as `capabilityText` presumably is.
- Either scan every `./`-relative module the card imports, or fail when the card imports a local component that contains a `CONTROL_TAGS` element without a classified literal `testID`.
- Add a mutant per escape route.

## Info

### IN-01: `wake host-key` refusals tell the user to use the broker host

**File:** `src/cli/handlers/wake.ts:147-160`
**Issue:** `assertWakeRunsOnBroker` wraps every verb, and its messages say "run it in a shell on the broker host itself". `wake host-key` is meant to run on the host to be woken (specs/wake.ts notes), so the advice points the Owner at the wrong machine.
**Fix:** Take the verb into account: for `wake host-key`, say "on the host to be woken".

### IN-02: Wake attempts are never cleared, so old evidence follows the card

**File:** `mobile/src/components/use-host-card-wake.ts:35`, `:96-99`
**Issue:** `attempts[host.id]` lives for the whole Home mount.
- After a wake, the host may sleep again. The Wake control reappears, because `powerAwake` is now false, but the card still reads "Host answered after wake" from the earlier press.
- If the host is re-paired under the same id with a rotated key, the old attempt still renders under the new pairing.

**Fix:** Drop an attempt when the card's `hostKey` no longer equals the key it was pressed under. Stop rendering target-observed stages once the target has disconnected after `repliedAt`.

---

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 1     | block  |
| HIGH (warning) | 4 | warn |
| INFO     | 2     | note   |

Verdict: BLOCK (CR-01: the feature cannot render against a real broker; fix the unwrap and make the fixture able to fail).

_Reviewed: 2026-10-28_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_

## Fix Log (batch A)

Scope: CR-01, WR-01, WR-02 and IN-02. WR-03, WR-04 and IN-01 are left for batch B. Work tree `C:\owx-haf`, branch
`mobile/host-availability`. Laptop runs were single vitest files, typechecks and gates. Mobile runs went to GEX44 through
the phase 18 runner in disposable roots. These are UNIT and GATE results; none of them is phone evidence.

| Commit | Kind | Finding | Change |
|---|---|---|---|
| `f9ecd5d57` | RED | CR-01 | Adds the laptop contract test `src/main/runtime/rpc/methods/host-wake-targets-reply-contract.test.ts`. It calls the real `createWakeBroker` + `wakeBrokerHost` + `HOST_WAKE_METHODS` `host.wake.targets` handler, feeds the answer to the parser, and asserts that the bound card routes. It also asserts that the phone session stores the answer only through the parser. The mobile fixtures now settle the wire shape `{ targets: [...] }`. |
| `c1d39c08c` | RED | WR-01, WR-02, IN-02 | Adds the read-code rows, the answered-target rule and the re-read skip rows. Adds a live-client check before the press, the options rows and a real `RpcClient` disconnected-press row. Adds the rows for an ended attempt and for the pairing key. |
| `6952eedeb` | GREEN | CR-01 | Adds `parseHostWakeTargetsReply` in `src/shared/host-wake-proxy.ts`, which returns the array or null. The phone session stores the answer through it, so a malformed answer reads as `targets_unreadable`. The composer's array contract is unchanged. |
| `fb9e6eff1` | GREEN | WR-01 | Adds `statusReadCode`, kept apart from `refusalCode`. Adds `wakeAttemptFurthestStage`, `isTargetObservedStage` and `statusReadHidesStage` in `host-card-wake-stage.ts`. The target's answer outranks any read. `wake_unknown` keeps the furthest stage. Any other read refusal shows `wake.unknown` ("Wake status unknown", existing label; no new label, claims unchanged). Focus re-reads skip read-closed or answered wakes. |
| `8f6f2e04b` | GREEN | WR-02 | `planHostWakePress` requires the routed broker client's live `getState() === 'connected'`. Both wake RPCs send `{ timeoutMs: 10_000, budgetSpansConnect: true, failWhenDisconnected: true }`. A disconnected press settles at once as unknown, and nothing is sent after reconnect. |
| `8c127a2d5` | GREEN | IN-02 | `endedWakeAttempts`: once the target has answered after the press and is no longer connected, the hook hides the attempt at once and prunes it by `requestId`. `wakeAttemptForPairing` shows an attempt only under the card key it was pressed under. |

Why IN-02 uses these rules: the two rules are the smallest pair that covers both cases.
- An attempt describes one boot of one identity.
- A re-pair under a different key is a different identity. It is hidden by comparing keys, which needs no new wire field.
- "Answered, then not connected" marks the end of that boot. The attempt is pruned from state rather than only hidden, because the target's next connect would otherwise satisfy `targetAnswerAfterPress` again and show the old wake.
- A target that has not answered yet keeps its attempt while it is down. That is the normal boot window.

The pruning effect raises one advisory `react-doctor(no-adjust-state-on-prop-change)` warning (exit 0). The flash it warns about is prevented because `wakeFor` applies the same rule at render.

Evidence (exact lines):
- UNIT laptop RED at `f9ecd5d57`: the contract file gave `Tests 3 failed | 1 passed (4)` (`TypeError: parseHostWakeTargetsReply is not a function`, plus the binding row). The control row, where the raw answer routes nothing, passed against the real handler.
- UNIT GEX44 RED at `c1d39c08c` (no sync, HEAD = old code + corrected tests). Root `/tmp/orca-phone-p18-20261028T162608Z`.
  - Result: `Tests 14 failed | 93 passed (107)`, `RUNNER result=FAIL`, `TEARDOWN procs=0 root=absent`, `PROOF ROOT_ABSENT_CONFIRMED`, `LOCAL exit=1`.
  - The three CR-01 fixture rows were among the failures, together with every WR-01, WR-02 and IN-02 row except the two guard rows that hold on old code.
- MUTANT P21-C1 (CR-01 re-planted, raw `response.result`): CAUGHT by the laptop contract test and by the GEX44 fixture test, then RESTORE_VERIFIED by byte copy (sha256 `B33C7E1F…821B`). See 21-06-MUTANTS.md.
- UNIT/GATE GEX44 full at `8c127a2d5` (no sync). Root `/tmp/orca-phone-p18-20261028T163529Z`.
  - Tests: `Test Files 3 passed (3)`, `Tests 122 passed (122)` over the session test, the presenter test and `MobileHostCard.test.tsx`.
  - Lint and format: `RUNNER oxlint_rc=0 oxfmt_rc=0`.
  - Typecheck: `RUNNER tsc_errors_total=3 tsc_errors_preexisting=3 tsc_errors_touched=0`. The three are the pre-existing MermaidDiagram, terminal-webview-html and mobile-workspace-client errors.
  - Run close: `RUNNER result=PASS`, `TEARDOWN procs=0 root=absent`, `PROOF ROOT_ABSENT_CONFIRMED`, `LOCAL exit=0`.
- UNIT laptop at `8c127a2d5`: contract `Tests 4 passed (4)`, `src/shared/host-wake-proxy.test.ts` `Tests 49 passed (49)`, `src/main/runtime/rpc/methods/host-wake.test.ts` `Tests 12 passed (12)`.
- Typechecks: `typecheck:node`, `typecheck:cli` and `typecheck:web` each exit 0.
- GATE laptop:
  - `check-host-card-claims: 41 labels classified, 3 controls classified, 600 host RPC methods known, no unevidenced power-loss state, no control without an effect, 6 capability producers classified, 3 capability emitters scanned.` This line is unchanged, so nothing needed re-pinning.
  - `Recurring-work inventory OK [total=236 interval=48 watcher=8 self-rescheduling-timeout=102 worker=13 helper=36 self-rescheduling-frame=29] debt=0`. No timer was added.
  - `check:durability-contracts` exit 0.

Still owed: the phone leg. A real phone, or a labelled emulator, must press Wake on a sleeping, bound host. It stays human_needed.

## Fix Log (batch B)

Scope: WR-03, WR-04 and IN-01. Batch A (CR-01, WR-01, WR-02, IN-02) is untouched; its rows were re-run green below.
Work tree `C:\owx-haf`, branch `mobile/host-availability`. Laptop runs were single named vitest files, typechecks and
gates. Mobile runs went to GEX44 through the phase 18 runner in disposable roots. These are UNIT, GATE and MUTANT
results; none of them is phone evidence.

| Commit | Kind | Finding | Change |
|---|---|---|---|
| `1660caeed` | RED | IN-01 | `src/cli/handlers/wake.test.ts`: all three refusal paths of `wake host-key` (bridged shell, `--environment`, remote runtime) must name the host to be woken and never the broker; control: `wake grant list` still names the broker host. |
| `ae0a5d3e5` | GREEN | IN-01 | `assertWakeRunsLocally(ctx, env, verb)` picks the command label (`orca wake host-key (read on the host to be woken)`) for `assertLocalInvocation` and the machine named by the two retarget refusals, per verb. |
| `21fbdc8a1` | RED | WR-03 | Broker rows in `host-wake.test.ts` (mismatched key, key for an unbound target, matching key, no key, replay after a rebind); phone rows (plan and wire params carry the card key); presenter rows (twelve phone refusal codes, own warning label, 42/20 table); gate pin 42 labels. |
| `5eeacea5b` | GREEN | WR-03 | `host.wake.request` takes an optional `hostKey` (`HOST_KEY_FORM`). `judgeBinding` refuses `wake_target_rebound` at the request and again at the effect-moment re-judge when the target's current `hostKey` differs; no key keeps today's behaviour. The code is in `HOST_WAKE_REFUSAL_CODES`, so it passes through `mapRuntimeError`. The phone's press plan carries the card key and `requestHostWake` always sends it. New label `wake.wake_target_rebound` "Wake refused: target bound to another host", classified (observer broker). |
| `fdce955ca` | test | WR-03 | The presenter text-law row counts 18 broker/phone wake labels (pin missed by the RED commit; the GEX44 run at `5eeacea5b` failed 1/124 on that count alone). |
| `af10c7ca8` | RED | WR-04 | New `config/scripts/host-card-copy-reach.test.mjs` (9 rows: each leak path red with a green twin, a split identifier `host-woken`, a transitive presenter helper, a child component, a boundary row); success-line pin and shape end `4 card copy modules scanned.` |
| `c36a2e0a5` | test | WR-03 | The G7 non-vacuity row expects 20 wake labels (second pin the WR-03 RED commit missed; seen in the WR-04 RED run). |
| `6228dcc3d` | GREEN | WR-04 | G8 `config/scripts/host-card-copy-reach.mjs` (133 lines), called from the gate (596 lines): card, presenter and every module they reach by relative imports inside the card's directory (today `StatusDot.tsx`, `host-card-wake-stage.ts`). No copy outside `HOST_CARD_LABELS` may read as woken; effect wording in a child `.tsx` passes only inside a backed effect control (G5 scope), in a `.ts` module it fails. Known limits are listed in the `config/host-card-claims.jsonc` header. |
| `b83935d3d` | docs | all | Pinned line updated in `docs/reference/host-wake-broker.md` (also the press `hostKey` rule and G8), `20-VERIFICATION.md`, `21-VERIFICATION.md`, STATE.md current-position and resume lines; P21-H1/G1/G2 appended to `21-06-MUTANTS.md`. |

Wire compatibility (remote-wire-compatibility.md): `hostKey` is a new optional request field. The dispatcher runs
`method.params.safeParse`, and `z.object` strips unknown keys, so an old broker drops it and wakes as before; that is
the accepted degrade, and the check exists only on new brokers. `wake_target_rebound` is only ever sent to a caller
that sent `hostKey`, so no old phone can receive it; an unknown code would still render `wake.unknown`.

Evidence (exact lines):
- UNIT laptop IN-01: RED at `1660caeed` `Tests 1 failed | 51 passed (52)`; GREEN `Tests 52 passed (52)`, `typecheck:cli` rc=0.
- UNIT laptop WR-03 RED (tree = `21fbdc8a1`): `Tests 4 failed | 45 passed (49)` (the three refusal rows `expected true to be false`, plus the 42-label pin).
- UNIT GEX44 WR-03 RED at `21fbdc8a1` (no sync), root `/tmp/orca-phone-p18-20261028T165609Z`: `Tests 6 failed | 102 passed (108)`, `RUNNER result=FAIL`, `TEARDOWN procs=0 root=absent`, `PROOF ROOT_ABSENT_CONFIRMED`, `LOCAL exit=1`.
- UNIT laptop WR-03 GREEN: `Test Files 4 passed (4)`, `Tests 63 passed (63)`; `typecheck:node`, `typecheck:cli`, `typecheck:web` rc=0.
- UNIT GEX44 full at `5eeacea5b`, root `/tmp/orca-phone-p18-20261028T165914Z`: `Tests 1 failed | 123 passed (124)` (text-law count 17), `RUNNER tsc_errors_total=3 tsc_errors_preexisting=3 tsc_errors_touched=0`, `RUNNER result=FAIL`, `TEARDOWN procs=0 root=absent`, `PROOF ROOT_ABSENT_CONFIRMED`, `LOCAL exit=1`.
- UNIT/GATE GEX44 full at `fdce955ca` (no sync; no mobile file changed after it), root `/tmp/orca-phone-p18-20261028T170033Z`:
  - `Test Files 3 passed (3)`, `Tests 124 passed (124)` over the session test, the presenter test and `MobileHostCard.test.tsx`;
  - `RUNNER oxlint_rc=0 oxfmt_rc=0`; `RUNNER tsc_errors_total=3 tsc_errors_preexisting=3 tsc_errors_touched=0` (MermaidDiagram, terminal-webview-html, mobile-workspace-client, as before);
  - `RUNNER result=PASS`, `TEARDOWN procs=0 root=absent`, `PROOF ROOT_ABSENT_CONFIRMED`, `LOCAL exit=0`.
- UNIT laptop WR-04 RED at `af10c7ca8`: `Tests 12 failed | 60 passed (72)` (all 9 reach rows, the success-line pin and shape, and the G7 count row).
- UNIT laptop WR-04 GREEN: `Test Files 4 passed (4)`, `Tests 104 passed (104)` over the four gate test files.
- MUTANT P21-H1, P21-G1, P21-G2: each CAUGHT and RESTORE_VERIFIED by byte copy (21-06-MUTANTS.md, batch B section).
- Final laptop re-run at `b83935d3d`: 8 named files `Test Files 8 passed (8)`, `Tests 226 passed (226)` (wake CLI, host-wake, targets-reply contract, host-wake-proxy, and the four gate test files); `typecheck:node`, `typecheck:cli`, `typecheck:web` rc=0.
- GATE laptop at `b83935d3d`:
  - `check-host-card-claims: 42 labels classified, 3 controls classified, 600 host RPC methods known, no unevidenced power-loss state, no control without an effect, 6 capability producers classified, 3 capability emitters scanned, 4 card copy modules scanned.`
  - `Recurring-work inventory OK [total=236 interval=48 watcher=8 self-rescheduling-timeout=102 worker=13 helper=36 self-rescheduling-frame=29] debt=0` (no timer added).
  - `check:durability-contracts` exit 0 (22 contracts, no new ones).
  - `git diff --quiet -- src config mobile` exit 0.

Incidents, stated plainly:
- The first IN-01 RED invocation passed the file list to vitest as a splatted string, so it ran the whole laptop suite
  for several minutes before it was killed (all its node processes stopped, none left). It made no commit. It left an
  untracked `NUL` file in `C:\owx-haf`, which was deleted; `git status` was clean apart from the edited test afterwards.
  The helper now takes an array and refuses a short entry.
- lint-staged's oxfmt rewrote `src/cli/handlers/wake.ts` and `src/main/runtime/wake-broker.ts` with LF where autocrlf
  checks out CRLF, so `git status` listed them as modified with no content diff (`git diff --stat` empty,
  `diff --quiet` 0). Both were re-checked-out only after `diff --quiet` returned 0.

Residual: WR-03's check needs a new broker; a new phone against an old broker wakes as before (accepted degrade). G8
is a text scan; what it cannot follow is listed in the jsonc header. Still owed: the phone leg (human_needed).
