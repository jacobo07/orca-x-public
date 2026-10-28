---
phase: 21-mobile-wake-control-on-the-host-card
plan: 02
subsystem: wake-routing
status: complete
tags: [wake-on-lan, wake-broker, host-key, routing, shared]
requires: [21-01 isHostKey + HostWakeTargetSummary.hostKey, 20-03 composeWakeProxyAvailability, host-key-fingerprint.ts]
provides:
  - composeHostWakeRoute, HOST_WAKE_ROUTE_REASONS, HostWakeRouteReason, WakeRouteBroker, HostWakeRoute (src/shared/host-wake-proxy.ts)
  - hostKeyFromPublicKeyB64 (digest injected, no node: import)
  - pinned vector for the phone (21-05)
affects: [21-04 card render, 21-05 press routing and phone-side derivation]
tech-stack:
  added: []
  patterns: [per-broker evidence reuse, injected digest for a node-free shared module, hand-written route table]
key-files:
  created: []
  modified:
    - src/shared/host-wake-proxy.ts
    - src/shared/host-wake-proxy.test.ts
    - src/main/runtime/host-key-fingerprint.test.ts
decisions:
  - "HOST_WAKE_ROUTE_REASONS is a separate constant; WAKE_PROXY_UNKNOWN_REASONS stays seven (asserted)"
  - "isGrantedTarget became a type guard (same runtime test) so the composer reads targetId without a cast"
  - "the entry-side isHostKey stays although the card check makes it equivalent (mutant R5), because the plan's key_links require it"
  - "hostKeyFromPublicKeyB64 strips every `=` and re-pads canonically; Node's atob accepts unpadded text (mutant D1 survived), the re-pad is engine-independent defense for Hermes, which this laptop cannot run"
metrics:
  duration: "~15 min (15:32 to 15:47)"
  completed: 2026-10-28
  tasks: 3
  files: 3
estimate:
  tokens: 65000
actuals:
  tokens: 3926        # chars/4 over the added lines of BASE..HEAD (15705 chars)
  tasks: 3
  commits: 7
plan_head_before: 92b66cb8ef73cefe7bcaf38f5a83ab4a373686af
---

# Phase 21 Plan 02: Shared wake route composer and phone-side hostKey Summary

`composeHostWakeRoute` decides where a card's Wake goes. It uses only this session's broker answers, and each broker
must pass `composeWakeProxyAvailability`. It returns a route only when exactly one available broker, other than the
card's own host, lists exactly one target whose `hostKey` equals the card's key. Two matches are `ambiguous_broker`.
Zero matches are `no_bound_target`. A missing or malformed card key is `no_host_key`. `hostKeyFromPublicKeyB64` gives
the phone the host's own fingerprint rule. It agrees with `fingerprintHostPublicKey` on 64 random keys and on 16
unpadded and double-padded keys, and it is pinned by one vector.

BASE (HEAD before the first commit of this plan): `92b66cb8ef73cefe7bcaf38f5a83ab4a373686af`.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 RED | 273826490 | test(21-02): RED composeHostWakeRoute |
| 1 GREEN | 06f94611d | feat(21-02): composeHostWakeRoute routes a card to the one broker bound to its hostKey |
| 2 table | 2d1865af1 | test(21-02): route rule table, first-run pass, five of six mutants caught |
| 3 RED | a667baf4c | test(21-02): RED shared hostKey derivation |
| 3 GREEN | 932c83d85 | feat(21-02): hostKeyFromPublicKeyB64 derives the host fingerprint on the phone |
| 3 fix | d6f65e320 | fix(21-02): purity row locates the module with __dirname so typecheck:cli compiles |
| 3 doc | 40f91eb05 | refactor(21-02): correct the re-pad comment to what atob was measured to do |

## Pinned vector (21-05 hardcodes this line on the phone)

```
VECTOR AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8= -> Yw3NKWbEM2aRElRIu7JbT_QSpJxzLbLIq8G4WBvXEN0
```

Input: the 32 bytes 0x00..0x1f in standard base64. The output was computed independently with node:crypto
(`createHash('sha256').digest('base64url')`) before the derivation existed. The test asserts both functions against
the literal with `toBe`.

## Task 1: tracer

- RED (273826490), `pnpm exec vitest run --config config/vitest.config.ts src/shared/host-wake-proxy.test.ts`:
  `Tests  3 failed | 20 passed (23)`, cause `TypeError: composeHostWakeRoute is not a function`.
- GREEN (06f94611d): `Test Files  1 passed (1)`, `Tests  23 passed (23)`. typecheck:node and
  `tsc --noEmit -p config/tsconfig.tc.web.json` exited 0.
- Tracer gate (auto chain): the plan's `<verify>` was re-run end to end after GREEN and passed before Task 2 started.
- Positive control: broker `host-broker` routes to `wt_0123456789ab` with `observedAt` T0+1. That is the older of
  status (T0+1) and targets (T0+2), the evidence time composeWakeProxyAvailability reports. The expectation is a
  hand-written literal.
- `composeWakeProxyAvailability` and `planWakeRequest` are unchanged. The 20-03 coverage test passed unmodified.

## Task 2: route rule table

- 26 route rows in the file: 3 from Task 1 and 23 added in Task 2. Each names its rule:
  - 5 evidence rows, where the only bound broker is disconnected, has `lastConnectedAt` null, gave status before
    its connect, lacks `host.wake-broker.v1`, or gave targets before its connect. Each reads `no_bound_target`.
  - 2 mixed rows (a stale bound broker beside a current one, in both orders). Both route to the current broker.
  - 1 row with two targets on one broker, which reads `ambiguous_broker`.
  - 1 old-broker row, where a label, targetId or broker name equal to the card key or host never routes.
  - 5 malformed-entry rows: 42 characters, a trailing pad, `+`, `/`, a number.
  - 1 row with a bound key on an entry that has no targetId.
  - 4 card rows (null, empty, 42 characters, standard alphabet). Each reads `no_host_key`, and the entry repeats the
    card value so that the card check is what refuses.
  - 2 self rows. The card host alone reads `no_bound_target`; beside a real broker it routes to the real broker.
  - 2 other-host rows (a K2 binding alone, and beside the K binding).
- Three more checks:
  - Fixture keys are well formed and distinct, and there are at least 14 rows.
  - Every `HOST_WAKE_ROUTE_REASONS` member is reached and matches `/^[a-z0-9_]{1,64}$/`, and
    `WAKE_PROXY_UNKNOWN_REASONS` still has length 7.
  - Purity: the module's import specifiers contain no `storage`, `async-storage`, `secure-store` or `node:`. A positive
    control asserts that `./host-wake` is seen.
- First run: `Tests  49 passed (49)`. There were 0 RED rows, because the Task 1 GREEN already implemented every rule
  in the plan's GREEN action. Discrimination was proven instead with uncommitted mutants of
  `src/shared/host-wake-proxy.ts`, each restored from HEAD (`RESTORE_VERIFIED_EXIT=0`):
  - R1 self broker allowed: CAUGHT (2 failed, both self rows).
  - R2 first match wins: CAUGHT (3 failed, both D-04 rows and reason coverage).
  - R3 label/targetId fallback: CAUGHT (the old-broker row).
  - R4 card form unchecked: CAUGHT (3 card rows).
  - R5 entry-side `isHostKey` removed: SURVIVED, an equivalent mutant. The card key has already passed `isHostKey`,
    so an equal entry is well formed. The check stays as defense in depth (key_links).
  - R6 connected-only, no currency: CAUGHT (9 failed: 4 evidence rows, 2 mixed rows, the tracer, a self row and an
    other-host row, all through the evidence time or the currency rule).
- Every function in the composer is under 50 lines. The match collection is split into `boundTargetIds` and
  `collectRouteMatches`.

## Task 3: phone-side derivation

- RED (a667baf4c), `src/main/runtime/host-key-fingerprint.test.ts`: `Tests  5 failed | 5 passed (10)`, cause
  `TypeError: hostKeyFromPublicKeyB64 is not a function`.
- GREEN (932c83d85), both test files: `Test Files  2 passed (2)`, `Tests  59 passed (59)`. typecheck:node and web tsc
  exited 0.
- Rows:
  - 64 random keys equal `fingerprintHostPublicKey` and pass `isHostKey`.
  - 16 keys agree across padded, unpadded (43 characters) and double-padded (`==`) text.
  - The digest receives exactly the 32 decoded bytes.
  - These inputs return null from both functions, and the digest is never called: 31 and 33 bytes, 41 data
    characters, junk `!!`, a leading space, a trailing newline, three pads, the URL-safe alphabet (two keys) and the
    empty string.
  - The pinned vector.
- Mutants on the derivation and the purity row, uncommitted and restored from HEAD:
  - D1 re-pad removed: SURVIVED. Node's atob accepted unpadded text, so the original comment was wrong; corrected in
    40f91eb05.
  - CAUGHT: D2 no pad strip, D3 any length, D4 no text rule, D5 standard alphabet out, D6 padding kept in the
    output, P1 a `node:crypto` import, P2 a `./host-wake-session-storage` import.
- `Select-String -Path src/shared/host-wake-proxy.ts -Pattern "from 'node:"`: 0 matches.

## Final verification (HEAD 40f91eb05)

- `pnpm exec vitest run --config config/vitest.config.ts src/shared/host-wake-proxy.test.ts src/main/runtime/host-key-fingerprint.test.ts`:
  `Test Files  2 passed (2)`, `Tests  59 passed (59)`.
- `pnpm run typecheck:node` exit 0. `pnpm exec tsc --noEmit -p config/tsconfig.tc.web.json` exit 0.
  `pnpm run typecheck:cli` exit 0.
- No mobile file changed. 21-05 consumes the vector above and passes `@noble/hashes` sha256 as the digest.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] typecheck:cli broke on the purity row**
- **Found during:** Task 3 verification.
- **Issue:** typecheck:cli compiles `src/shared` tests as CommonJS, so `import.meta.url` in the Task 2 purity row
  failed with TS1470. 21-01 had recorded typecheck:cli exit 0. typecheck:node and web tsc were green, which is why
  it was not seen at 2d1865af1.
- **Fix:** `join(__dirname, 'host-wake-proxy.ts')`, the same form as `orca-yaml-requirements-docs.test.ts`. The
  assertions are unchanged.
- **Commit:** d6f65e320. Commits 2d1865af1 through 932c83d85 fail typecheck:cli. Every GREEN commit (06f94611d,
  2d1865af1, 932c83d85, d6f65e320, 40f91eb05) passes typecheck:node. The two RED commits import exports that do
  not exist yet, as RED does.

**2. [TDD note] Task 2 had no RED**
- The plan's Task 1 GREEN action describes the full algorithm (self skip, per-broker availability, isHostKey on the
  card and the entries, ambiguity), so Task 2's rows passed on the first run. The commit is not titled "RED". Its
  body and this summary carry the mutant evidence (R1-R4 and R6 CAUGHT, R5 equivalent). No GREEN commit was needed.

**3. [Rule 1 - Accuracy] Re-pad comment**
- Measured: Node's atob accepts unpadded base64 (D1 survived). The comment now says what is true. The canonical
  re-pad stays because Hermes was not measured here. Commit 40f91eb05, comment only.

## Known Stubs

None. `composeHostWakeRoute` and `hostKeyFromPublicKeyB64` are pure and complete. Their UI and press consumers are
21-04 and 21-05 by plan; until then the composer is UNIT, wired but unrendered.

## Threat Flags

None beyond the plan's register.
- T-21-07: exact hostKey only; label, targetId and broker name never match (R3); self excluded (R1).
- T-21-08: `ambiguous_broker` with no order or recency pick (R2, mixed rows in both orders).
- T-21-09: per-broker currency (R6) and the purity row (P1, P2).
- T-21-10: equivalence over 64 + 16 keys, the rejection rows and the vector.
- T-21-11: accepted as planned.

## Self-Check: PASSED

- FOUND: src/shared/host-wake-proxy.ts, src/shared/host-wake-proxy.test.ts, src/main/runtime/host-key-fingerprint.test.ts
- FOUND commits: 273826490, 06f94611d, 2d1865af1, a667baf4c, 932c83d85, d6f65e320, 40f91eb05
  (`git rev-list --count 92b66cb8e..HEAD` = 7)
