# Phase 21 plan check (gsd-plan-checker, 2026-10-28)

Plans checked: 21-01 .. 21-06. Read-only, except for this file.

## Coverage
- SC1 (routing, no MAC): 21-01 T1-T3 (binding, projection, MAC_PATTERN afterEach over a bound reply), 21-02 T1-T3 (composeHostWakeRoute, ambiguity, vector), 21-05 T1 (press goes to the routed broker only).
- SC2 (stages): 21-04 T2 (rebasing, target-after-press rule, refusal closed table, text law), 21-05 T2 (focus re-read, no timer).
- SC3 (gate, mutants, GEX44, human_needed): 21-03 T1-T3, 21-04 T1 (41/3 pin), 21-06 T1-T3.
- D-01..D-12 are each claimed and implemented. Deferred items (discovery and auto-registration, a desktop surface, the pre-suspend announcement) appear in no task.

## Same-wave disjointness (wave 2)
- 21-02 files_modified: src/shared/host-wake-proxy.ts, src/shared/host-wake-proxy.test.ts, src/main/runtime/host-key-fingerprint.test.ts.
- 21-03 files_modified: config/scripts/host-card-effect-claims{,.test}.mjs, config/scripts/check-host-card-claims.mjs, config/host-card-claims.jsonc, src/shared/host-wake.ts.
- No shared file. 21-02 only reads host-wake.ts, and the plans run sequentially.

## Premises verified in code
- host-key-fingerprint.ts:10-17 has a regex, a 32-byte rule and a base64url sha256 (node:crypto). The plan keeps node: out of the shared module by passing the digest in.
- Mobile can compute the same fingerprint: mobile/package.json:21 has @noble/hashes 1.8.0, already used at mobile-relay-credential-hash.ts:1, and RN ^0.83.9 (Hermes atob). No node:crypto assumption on mobile.
- HostProfile.publicKeyB64: mobile/src/transport/types.ts:71.
- isStoredTarget (wake-broker-state-schema.ts:30-45) accepts extra keys. targetsFor projection: wake-broker.ts:297.
- Card-wide short-circuit `effectBacked`: check-host-card-claims.mjs:477-486 (CONTEXT's :427-436 is stale; the plan line is correct).
- MobileHostCard: host-card-open :90, host-card-capabilities :134, host-card-actions :150.
- useFocusEffect: mobile/app/index.tsx:4 and :325.
- Runner: 18-gex44-mobile-vitest.ps1:10-24 has -Mode, -Sync and -Files, comma-split.
- Key source: index.ts:2850 is readE2EEPublicKey(getCanonicalUserDataPath()).
- Revocation latch: rpc-client.ts:527-528 fires only on code 'unauthorized'. Wake refusals use wake_* codes (wake-broker.ts:140), so they cannot latch.
- Pinned line today: host-capability-producer-gate.test.mjs:94 reads `22 labels classified, 2 controls classified`.
- Scripts exist: typecheck:node, typecheck:cli, check:* (package.json:31-74). config/tsconfig.tc.web.json exists.

## Security and laws
- Pass: the new verbs are local-only (isLocalRpcCaller plus assertLocalInvocation, ORCA_CLI_CWD refused).
- Pass: no MAC reaches the phone.
- Pass: exact hostKey match only; ambiguous_broker yields no route.
- Pass: Zod stripping is avoided by adding a separate targetBind method.
- Pass: no timer; nothing persisted.
- Pass: GEX44 runs carry teardown and proof lines.
- Pass: mutants are restored by byte copy with sha256 and diff-quiet.
- Pass: never push.
- Pass: the `wake` literal stays inside the host-card-wake Pressable (stage testID host-card-request-stage).
- Pass: no max-lines disables; files are split on cap.

## ISSUES FOUND

1. **WARNING, 21-01 Task 3.** The behaviour row requires host_key_unavailable data.reason values `unreadable` and `malformed` as distinct outcomes. readE2EEPublicKey (e2ee-keypair.ts:92-99) returns `null` for both an unreadable file and an invalid one, and only `undefined` for not_minted. The row cannot be met through the named reader without editing e2ee-keypair.ts, which is not in files_modified. Fix: either collapse to `not_minted | unavailable` (null => unavailable, fingerprint null => malformed), or add e2ee-keypair.ts to files_modified and expose the read kind.
2. **WARNING, 21-01 Task 3.** No row proves that the readout equals the key the phone actually holds, i.e. the key the pairing offer and RuntimeRpcServer publish (runtime-rpc.ts:557-580 uses its own `this.userDataPath`). The plan reads getCanonicalUserDataPath independently. If the two diverge (a profile or serve data dir), every binding silently yields no control. That fails closed, but SC1 would never be reachable. Fix: source the key from the same path the server or pairing offer uses (ctx or runtime), or add a row asserting equality with the pairing-offer publicKeyB64.
3. **WARNING, 21-RESEARCH.md.** `## Open Questions` (:367-371) is not marked RESOLVED. Both questions are answered by orchestrator decisions 2-3 and by 21-01 T3 (local CLI readout; own-key refusal). Fix: mark the heading `(RESOLVED)` with one-line answers.
4. **WARNING, 21-01 Task 1, acceptance criterion 2.** `Select-String 'mac:'` "finds no match inside the targetsFor projection lines" cannot be checked mechanically, because the file contains `mac:` elsewhere. Fix: assert on the projection line itself, e.g. the `.map((target) => ({` line contains no `mac`/`broadcast`/`port`. The MAC_PATTERN afterEach remains the real catcher.
5. **WARNING, 21-01 scope.** The plan modifies 11 files, above the 10-file warning threshold. Execution can proceed; consider moving the CLI (Task 3) to its own plan if context runs tight.
6. **INFO, 21-05 Task 2.** The latch row tests namesDeviceRevocation, but the effective guard is rpc-client.ts:527 (`code === 'unauthorized'`). Fix: also assert that a wake_device_revoked reply passed through the fake client never reaches handleAuthRejection.
7. **INFO, 21-02 Task 3.** The equivalence uses padded random keys only. fingerprintHostPublicKey also accepts unpadded 43-character text (regex `={0,2}`). Fix: add an unpadded row so atob and Buffer agree.
8. **INFO, 21-05.** Research A4 (relay-upgraded profiles keep publicKeyB64) has no fixture row. It fails closed. Fix: add one profile fixture with a relay endpoint.
9. **INFO, 21-04 Task 3.** STATE.md:24 quotes the old 22/2 line as 20-04 history. It is correctly left as history, but the plan should say so explicitly so the executor does not "fix" or miss it.

---

# Re-check after revision (2026-10-28)

## Changes verified
- **W1 (fixed).** 21-01:106 and :213 now use a single `unavailable` reason plus `not_ready`. Both come from the attached key source, so the plan no longer needs a distinction that readE2EEPublicKey cannot make.
- **W2 (fixed).** The anchors exist in code:
  - runtime-rpc.ts:656 `getE2EEPublicKey()`.
  - :750 and :780 `createPairingOffer`, which publishes that same key.
  - :1304 `wakeBrokerHost.attachDeviceAuthority`.
  - wake-broker-host.ts:28 and :51.
  
  The in-process test (21-01:211) compares the readout with the fingerprint of the same server's pairing-offer key on a temp userData dir, and adds a control with a second keypair. The test can fail. A reader that went back to getCanonicalUserDataPath(), or to any other keypair, would differ from the temp-dir server's key. The fails_when text at :228 names both the mismatch and a matching control.
- **W3 (fixed).** The orchestrator marked RESEARCH Open Questions RESOLVED.
- **W4 (fixed).** An exact-keys test on phone replies was added.
- **W5.** 21-01 now has 14 files, under the 15-file blocker threshold, and runs alone in wave 1. Accepted.
- **Info items 6-9.** Added.

## Regressions
- Only 21-01 lists runtime-rpc.ts and wake-broker-host.ts. No wave-2+ plan lists either file. Wave 2 (21-02 and 21-03) remains disjoint.
- The testID is `host-card-request-stage` in every mention: 21-01:119, 21-04:40/126/133/154/160 and 21-05:101. `host-card-wake-stage` at 21-04:134 is an optional helper file name, not a testID, and contains no string literal on the card.
- The success line `41 labels classified, 3 controls classified` is consistent at 21-04:33/162/167/171/225. The RPC count of 600 is unchanged from 21-01.
- I found no new stub, timer or max-lines disable in the revised text.

## VERIFICATION PASSED
