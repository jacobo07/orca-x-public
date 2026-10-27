---
phase: 19-wake-on-lan-capability-and-the-lan-wake-broker-m2
plan: 05
subsystem: host-availability
status: complete
tags: [wake-on-lan, wake-broker, live-leg, scripted-client, mutants, verification, gex44]
requires: [19-01 WOL probe, 19-02 broker core, 19-03 serve-only broker and device authority, 19-04 local wake administration]
provides: [wake-broker-scripted-client.live.test.ts, 19-gex44-build-out.ps1/.sh, 19-05-evidence.json, 19-wol-probe-evidence.json, 19-VERIFICATION.md (status human_needed)]
affects: [.planning/STATE.md, .planning/ROADMAP.md]
tech-stack:
  added: []
  patterns: [relaunch on the same profile to mint a second pairing offer, same device credential re-addressed at a relaunched listener, loopback UDP listener as the independent positive control]
key-files:
  created:
    - src/main/runtime/wake-broker-scripted-client.live.test.ts
    - .planning/phases/19-wake-on-lan-capability-and-the-lan-wake-broker-m2/19-gex44-build-out.ps1
    - .planning/phases/19-wake-on-lan-capability-and-the-lan-wake-broker-m2/19-gex44-build-out.sh
    - .planning/phases/19-wake-on-lan-capability-and-the-lan-wake-broker-m2/19-05-evidence.json
    - .planning/phases/19-wake-on-lan-capability-and-the-lan-wake-broker-m2/19-wol-probe-evidence.json
    - .planning/phases/19-wake-on-lan-capability-and-the-lan-wake-broker-m2/19-VERIFICATION.md
  modified:
    - .planning/STATE.md
    - .planning/ROADMAP.md
decisions:
  - "19-05: device B is paired by relaunching the broker on the same scratch profile: a paired A leaves getOrCreatePendingDevice free to mint a new pending device; A reconnects with its own credential re-addressed at the new listener"
  - "19-05: P19-M6 plants inside authorizeCaller (shared by the first check and the pre-send re-check) so a not-ok verdict is treated as ok for the caller's device"
  - "19-05: phase 19 VERIFICATION is human_needed: SC1 measured, SC2 PASS, SC3 OWNER_BOUND; live revoke not claimed; Wake control DEFERRED under D-13"
metrics:
  duration: 45min
  completed: 2026-10-27
plan_head_before: 1de3a0c85ff3324528451646ce0a4e660b935fef
actuals:
  tokens: 14840
  tasks: 3
  commits: 3
---

# Phase 19 Plan 05: Live proof, WOL measurement and mutant drills Summary

This plan proved the broker live. A disposable `--serve-wake-broker` serve host ran on this laptop from `out/` built on GEX44 at 1de3a0c85. A SCRIPTED CLIENT made one granted wake, and an independent loopback listener captured exactly one 102-byte magic packet for the fictitious MAC. The run also observed the ungranted refusals, replay, adoption and a no-broker host that refuses. The laptop's WOL capability was re-measured read-only. Six mutants were caught and restored.

19-VERIFICATION.md is `human_needed`:
- SC1 is measured: `unknown/firmware_unverified`.
- SC2 is PASS.
- SC3 (LAN Product Reality) is OWNER_BOUND.

## Tasks

| Task | Name | Commit |
|------|------|--------|
| 1 (tracer) | GEX44-built out/ at HEAD, one granted SCRIPTED CLIENT wake, one captured frame | 0ee75031d |
| 2 | Refusals, idempotency, adoption, the no-broker host, the in-process revoke re-run, the WOL probe | 43e170ba2 |
| 3 | Mutant drills P19-M1..M6 and 19-VERIFICATION.md | 555cb218b |

## Verification (observed on this laptop, 2026-10-27)

### GEX44 build (Task 1, step 1)

- **Disposable root:** `/tmp/orca-phone-p19-20261027T201804Z`.
- **Toolchain:** node v24.21.0, pnpm 12.15.0.
- **HEAD built:** `RUNNER head=1de3a0c85ff3324528451646ce0a4e660b935fef`.
- **Build steps:** `install=ok`, `rebuild_node_pty=ok`, `build=ok`, 1000 entries.
- **sha256 on both ends:** `SHA256 remote=633f3a1500cb891f8a5c936cee504c1108d828542c0d49466c773d97f6352126 local=633f3a1500cb891f8a5c936cee504c1108d828542c0d49466c773d97f6352126`.
- **Extract:** only `out/` was extracted into C:\owx-haf, which is gitignored. The previous out/ (built 16:54) was moved aside and deleted after the run.
- **Teardown proof:**
  - `TEARDOWN procs=0 root=absent`, `PROOF NONE_P19`, `PROOF_AFTER NONE_P19`.
  - A later check, `pgrep -fa /tmp/orca-phone-p1[9]`, returned `NO_P19_PROCS`.
- **Untouched:** other sessions' roots on GEX44 (p12, p17, p20b).
- **Served code:** commits after 1de3a0c85 touch only the live test and `.planning/`, so the code served is the phase's code.

### Tracer (Task 1)

- **Leg run:** `vitest run src/main/runtime/wake-broker-scripted-client.live.test.ts` with `ORCA_LIVE_WAKE_LEG=1` gave `Test Files 1 passed (1)`, `Tests 1 passed (1)`. It was passed, not skipped.
- **Evidence** (`19-05-evidence.json` at the time):
  - `capabilitiesHaveWakeBroker: true`, `[serve] wake broker: enabled (0 targets)`.
  - Stages and composed stages: requested, authorized, packet-sent.
  - `listenerCount: 1`, `frameLength: 102`, `frameHexPrefix ffffffffffff02005e190001`.
  - Owner hash unchanged.
- **Tracer gate:** after the commit, the committed leg was re-run end to end and passed (`Tests 1 passed (1)`). Tracer verified end-to-end — expanding.

### Task 2

**Live leg at 0ee75031d** (`Tests 1 passed (1)`, 43.5 s). Each step's code and the listener count after it:

| Step | Code | Listener count after |
|---|---|---|
| Tracer wake | ACCEPTED | 1 |
| B, no grant, registered target | `wake_grant_missing` | 1 |
| B, unregistered target | `wake_grant_missing` | 1 |
| A, requestId R | ACCEPTED, `wk_8bae56c365bedf59` | 2 |
| A, R again | `replayed: true`, same wakeId | 2 |
| A, new requestId 6047 ms after R (window 10 000 ms) | `adopted: true`, same wakeId | 2 |
| No-flag host request | `wake_broker_disabled` | 2 |

- **Distinct wakes:** final count 2 equals 2 distinct accepted wakes, and every frame is a magic packet for the target.
- **B on A's wake:** `host.wake.status` returns `wake_unknown`. B's targets are `[]`.
- **No MAC to the phone:** none of the 13 phone replies holds a MAC-shaped string. The positive control is the local admin reply, which does match.
- **No-flag host:**
  - 54 capabilities, none of them `host.wake-broker.v1`.
  - `wake_broker_disabled` for request, targets and local admin `targetList`.
  - No wake stderr line.
- **Relaunch:** the relaunched broker printed `enabled (1 targets)`, so the target and A's grant survived.

**After the run:**
- Spawned pids were reaped. Scratch-family processes: 0, against a baseline of 0.
- The `broker`, `nobroker` and parent scratch dirs are absent.
- `Get-Process electron` under C:\owx-haf showed 0 before and 0 after.
- Owner `orca-devices.json` sha256 `510f9b74b076f86570b3ad39d3c3bdcfe522a8e9f6a43ac218a616f7a889a8ad` before and after (identical).

**In-process revoke** (UNIT in-process, real RuntimeRpcServer), re-run at 0ee75031d: `Tests 1 passed (1)`, exit 0. The result is merged into the evidence under `revokedDeviceRefusal`, together with "live revoke over a headless host: not claimed (no local revoke transport; Settings-only)".

**WOL probe** (`ORCA_LIVE_WOL_PROBE=1`): `Tests 1 passed (1)`.
- **Verdict line:** `{"value":"unknown","reason":"firmware_unverified","evidence":null}`.
- **Positive control:** the Realtek PCIe GbE Family Controller (`Ethernet`, 802.3) reads WakeOnMagicPacket `Enabled`, and powercfg returned 6 lines with armedCount 6.

**Confirmation:** the committed, lint-staged-formatted leg at 43e170ba2 was re-run and passed (`Tests 1 passed (1)`, 44.9 s).

### Task 3

- **Drills:** P19-M1..M6 are each PLANT_CONFIRMED, CAUGHT and RESTORE_VERIFIED. The commands, exits and decisive lines are in the 19-VERIFICATION.md mutant table.
- **Verify block on the final tree:**
  - 6 unit files: `Test Files 6 passed (6)`, `Tests 85 passed (85)`.
  - `check:host-card-claims` exit 0: 22 labels, 2 controls, 598 methods.
  - `check:durability-contracts` exit 0: 22 contracts, no new ones.
  - `check:recurring-work` exit 0: total 236, debt 0.
  - `git diff --quiet -- src config mobile` exit 0, and `git status --porcelain -- src config mobile` is empty.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] A serve host offers one pairing URL, so a second device needs a fresh pending offer**
- **Found during:** Task 2
- **Issue:** `printServeReady` mints a single offer, and no RPC creates another. The one other path is `mobile:getPairingQR`, an Electron IPC call.
- **Fix:** The leg kills the broker and relaunches it on the same scratch profile. A's first sighting is persisted inline (`updateLastSeenDeferred`), so `getOrCreatePendingDevice` mints a new pending device B. A reconnects with its own credential re-addressed at the new listener (`encodePairingOffer({...A, endpoint})`). The relaunch also proves the target and grant persisted (`enabled (1 targets)`).
- **Commit:** 43e170ba2

**2. [Rule 1 - Lint] An unused constant blocked the tracer commit**
- **Issue:** `MAC_SHAPED` was declared in the tracer before its use in Task 2, and oxlint rejected it in pre-commit.
- **Fix:** The constant was removed from the tracer and re-added in Task 2, where it is used. Nothing was committed by the failed attempt.

**3. [Mutant driver] The first P19-M1 attempt was void**
- **Issue:** `pnpm.ps1` joined the two test paths into one filter, so vitest printed `No test files found` and exited 1. That would have been a false CAUGHT.
- **Fix:** The tree was restored (diff-quiet 0). The driver was switched to `pnpm.cmd`, and M1 was re-run and recorded. The void attempt is noted in 19-VERIFICATION.md.

**4. Observed, not as predicted: P19-M6**
- **Plan's prediction:** a second frame in-process.
- **Observed:** none. The revoke's grant purge is an independent guard, so the in-flight request was refused `wake_grant_missing`.
- **How it was caught:**
  - The in-process test failed at line 135 on the code.
  - The unit `refuses a revoked device with wake_device_revoked` row failed because the request was accepted.
- Recorded as observed.

### Notes

- **WOL verdict:** the plan predicted needs-owner-setup / os_not_armed. The laptop measures unknown / firmware_unverified because the NIC is already armed (as 19-01 found), so step (a) is recorded as measured, not owed.
- **STATE.md:** the gsd state commands are not used on this STATE.md format. Current Position and the Deferred Verification row for phase 19 were edited by hand.
- **lint-staged:** it reformatted the live test on commit, and the post-commit check was `cached=0 tree=0` every time.

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model:
- **T-19-24:** Owner device hash identical; scratch profile only.
- **T-19-25:** loopback broadcast and a fictitious, locally administered MAC.
- **T-19-26:** p19 root guard, `NONE_P19`.
- **T-19-27:** clean before each plant, diff re-read before checkout, diff-quiet after.
- **T-19-28:** every row is labelled, and SC3 is OWNER_BOUND.
- **T-19-29:** no powercfg write, BIOS change, sleep or task.

## Self-Check: PASSED

- All 6 created files exist.
- Commits 0ee75031d, 43e170ba2 and 555cb218b are on `mobile/host-availability`. `git rev-list --count 1de3a0c85..HEAD` = 3 before this summary commit.
- `actuals.tokens` = the plan diff, 59360 chars / 4.
