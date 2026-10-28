---
phase: 19-wake-on-lan-capability-and-the-lan-wake-broker-m2
status: human_needed
verified: 2026-10-27
owed:
  - "LAN Product Reality (SC3), OWNER_BOUND: step (b) BIOS Resume by PCI-E / LAN on and ErP off; step (c) an always-on LAN node running `orca serve --wake-broker`; then the ordered procedure below ending in host-announced, runtime-ready and fresh terminal output on the woken PC. Step (a) was measured already armed on this laptop (19-01, re-measured here)."
  - "The mobile Wake control on the host card: DEFERRED under D-13 (four reasons below); the SCRIPTED CLIENT drives host.wake.* instead."
---

# Phase 19 Verification: Wake-on-LAN capability and the LAN Wake Broker

Labels:
- **UNIT laptop** = vitest on this laptop, single files.
- **UNIT in-process (real RuntimeRpcServer)** = `wake-broker-revoke-in-process.test.ts`: a real
  `OrcaRuntimeRpcServer`, real DeviceRegistry, real authority attach, real UDP sender to a loopback listener. Not a
  served process and not SCRIPTED CLIENT.
- **SCRIPTED CLIENT live** = `wake-broker-scripted-client.live.test.ts`: a disposable windowless serve host on this
  laptop (worktree `electron.exe`, scratch userData and home through `ORCA_E2E_USER_DATA_DIR` / `ORCA_E2E_HOME_DIR`,
  loopback only), running `out/` built on GEX44 at **1de3a0c85** (disposable root `/tmp/orca-phone-p19-20261027T201804Z`,
  out.tgz sha256 `633f3a1500cb891f8a5c936cee504c1108d828542c0d49466c773d97f6352126` on both ends, root removed,
  `NONE_P19`), driven by the phone protocol. Commits after 1de3a0c85 touch only this live test and `.planning/`, so
  the served code is the phase's code.
- **MEASURED read-only probe** = `host-wol-probe.live.test.ts` with `ORCA_LIVE_WOL_PROBE=1` on this laptop.
- **MUTANT** = a planted change on the real tree, caught, then restored to HEAD.

Nothing here is REAL DEVICE, PHYSICAL or OWNER-OBSERVED. Nothing slept, armed, woke or reconfigured the Owner's PC.
No frame left 127.0.0.1: the target broadcast is the loopback listener and the MAC `02:00:5e:19:00:01` is locally
administered and fictitious.

## Success criteria

| SC | Criterion | Evidence | Label | Verdict |
|---|---|---|---|---|
| SC1 | WOL capability measured per platform, read-only; never `supported` from configuration | 19-01 verdict tables (26 rows win32/linux/darwin, none yields supported; plan set 6 files 111/111). Live, re-run here at 0ee75031d: `19-wol-probe-evidence.json` verdict `{"value":"unknown","reason":"firmware_unverified","evidence":null}`. Positive control: 1 adapter row `Ethernet / Realtek PCIe GbE Family Controller / 802.3 / WakeOnMagicPacket Enabled` (a setting actually read, not the `Unreadable` default); `powercfg /devicequery wake_armed` returned 6 lines, armedCount 6. P19-M4 CAUGHT | MEASURED + UNIT laptop + MUTANT | PASS (measured value; `supported` is owed to an observed wake, phase 20) |
| SC2 | A paired device wakes a registered target through a broker only with a grant; refused otherwise; idempotent; staged | Unit: 19-02 (55/55), 19-03 (60/60), 19-04 (117/117); here the 6-file set `Tests 85 passed (85)`. Live (table below, `19-05-evidence.json`): granted wake -> stages requested/authorized/packet-sent and exactly 1 102-byte frame for the MAC; ungranted B refused `wake_grant_missing` for the registered and for an unregistered target (no enumeration), listener unchanged; duplicate requestId replays the same wakeId with +1 frame for the pair; a new requestId at 6047 ms is adopted, +0; final listener count 2 = 2 distinct accepted wakes; the no-flag host lacks `host.wake-broker.v1` and refuses `wake_broker_disabled`. Revoked device: UNIT in-process (real RuntimeRpcServer), `wake_device_revoked`, listener 1 before and 1 after. P19-M1, M2, M3, M5, M6 CAUGHT | SCRIPTED CLIENT live + UNIT in-process (real RuntimeRpcServer) + UNIT laptop + MUTANT | PASS |
| SC3 | LAN Product Reality: a sleeping PC woken by a phone, Host Service reconnects, the terminal works | Not run. Owner steps (b) and (c) are missing; procedure below | OWNER_BOUND | OWNER_BOUND (not PASS) |

## SCRIPTED CLIENT live leg (19-05-evidence.json, run 2026-10-27 20:25Z at 0ee75031d)

Command: `$env:ORCA_LIVE_WAKE_LEG='1'` (+ `ORCA_LIVE_WAKE_ELECTRON`, `_APP_ROOT`, `_SCRATCH`, `_EVIDENCE`) then
`pnpm exec vitest run --config config/vitest.config.ts src/main/runtime/wake-broker-scripted-client.live.test.ts`:
`Test Files 1 passed (1)`, `Tests 1 passed (1)` (passed, not skipped). Re-run on the committed, formatted file at
43e170ba2: `Tests 1 passed (1)`.

| Step | Observed code | Listener count after |
|---|---|---|
| status.get on the `--serve-wake-broker` host | `host.wake-broker.v1` present; stderr `[serve] wake broker: enabled (0 targets)` | 0 |
| local admin over the runtime named pipe: `targetAdd` (loopback, listener port), `grantAdd` (A) | ok; target `wt_93b0f480c344` | 0 |
| A granted wake (tracer) | ACCEPTED; requested, authorized, packet-sent; `composeWakeProgress(status.stages, null)` ends at packet-sent | 1 (102 bytes, `ffffffffffff02005e190001...`, all 16 blocks = MAC) |
| relaunch on the same profile (pairs B; A reconnects); stderr `enabled (1 targets)` | B targets `[]`; A targets `[wt_93b0f480c344]` | 1 |
| B (no grant) requests the registered target | `wake_grant_missing` | 1 |
| B requests an unregistered target id | `wake_grant_missing` (grant-first) | 1 |
| A sends requestId R | ACCEPTED, `wk_8bae56c365bedf59`, replayed false | 2 |
| A sends R again | ACCEPTED, same wakeId, replayed true | 2 |
| B reads A's wake status | `wake_unknown` | 2 |
| A sends a new requestId 6047 ms after R (window 10 000 ms) | ACCEPTED, adopted true, same wakeId | 2 |
| 13 phone replies scanned for a MAC-shaped string | none; positive control: the local admin reply does match | 2 |
| second disposable host from the same out/ without `--serve-wake-broker`: status.get | 54 capabilities, no `host.wake-broker.v1`; no wake stderr line | 2 |
| paired device requests a wake / targets / local admin `targetList` on it | `wake_broker_disabled` x3 | 2 |

Final: listener 2 = distinct accepted wakes 2; every frame a magic packet for the target.
Teardown: spawned pids reaped true; scratch-family processes 0 (baseline 0); `broker`, `nobroker` and parent scratch
dirs absent; `Get-Process electron` under C:\owx-haf 0 before and 0 after. Owner `%APPDATA%\orca\orca-devices.json`
sha256 `510f9b74b076f86570b3ad39d3c3bdcfe522a8e9f6a43ac218a616f7a889a8ad` before and after (identical).

### Revoked device: UNIT in-process (real RuntimeRpcServer)

Re-run at 0ee75031d: `vitest run src/main/runtime/wake-broker-revoke-in-process.test.ts`, `Tests 1 passed (1)`, exit 0.
The test asserts: positive control ok with stages requested/authorized/packet-sent and exactly 1 frame of 102 bytes;
`revokeMobileDevice` resolves true; the in-flight dispatch is refused `wake_device_revoked` and its data does not
contain `device_revoked`; the WebSocket entry is refused `unauthorized` / `device_revoked` at dispatch; after a 1500 ms
settle the listener still holds 1 frame (1 before, 1 after); no grant in memory or on disk.

**live revoke over a headless host: not claimed (no local revoke transport; Settings-only)**. Revocation reaches a
device only through Electron IPC from Settings (`src/main/ipc/mobile.ts:246,254`); no revoke RPC was added (19-03 and
19-04 sweeps of `rpc/methods/*.ts`: 0 hits).

## Mutant drills (real tree, laptop, unit level)

Protocol per drill (driver `mutant.ps1` in the job tmp): `git diff --quiet -- <file>` exit 0 before the plant; the
anchor occurs exactly once; plant by that single replacement; PLANT_CONFIRMED = `git diff --name-only` names only
that file and the planted text is present; CAUGHT = the command exits non-zero with the expected failing test named;
restore with `git checkout -- <file>` only after the diff was re-read unchanged; RESTORE_VERIFIED = `git diff --quiet`
exit 0 and the same command exits 0 again. `git status --porcelain -- src config mobile` is empty after all six.

| Mutant | Plant (file: anchor -> plant) | PLANT_CONFIRMED | CAUGHT (command, exit, decisive line) | RESTORE_VERIFIED |
|---|---|---|---|---|
| P19-M1 grant check skipped | wake-broker.ts: `if (!deps.store.hasGrant(deviceId, targetId)) {` -> `if (false && ...)` | yes, `1 file changed, 1 insertion(+), 1 deletion(-)` | `vitest run wake-broker.test.ts rpc/methods/host-wake.test.ts`, exit 1, `FAIL host-wake.test.ts > host.wake.* phone methods > refuses an ungranted device with ...` (`expected true to be false`) and `FAIL wake-broker.test.ts > runs authority before dedupe ...` (`expected a refusal`); `Tests 2 failed \| 18 passed (20)` | diff-quiet 0; rerun exit 0, `Tests 20 passed (20)` |
| P19-M2 dedupe off | wake-broker.ts: `const prior = replays.get(replayKey)` -> `const prior = undefined as ...` | yes, 1 file, 1/1 | same command, exit 1, `FAIL wake-broker.test.ts > replays the same (target, requestId) within 60 s and sends ...` (`expected { wakeId: 'wk_2', ... } to deeply equal { wakeId: 'wk_1', ... }`) and `joins concurrent duplicates to one in-flight send`; `Tests 2 failed \| 18 passed (20)` | diff-quiet 0; rerun exit 0, 20/20 |
| P19-M3 packet-sent reported as host-announced | wake-broker.ts: `record(entry, 'packet-sent')` -> `record(entry, 'host-announced')` | yes, 1 file, 1/1 | same + `src/shared/host-wake.test.ts`, exit 1, suite `FAIL wake-broker.test.ts > wake broker` (`expected [ ...(271) ] to deeply equal []`: broker records carrying host-announced) and `FAIL host-wake.test.ts > sends exactly one 102-byte frame ...` (stages differ); `Test Files 2 failed \| 1 passed (3)` | diff-quiet 0; rerun exit 0, `Tests 27 passed (27)` |
| P19-M4 armed config reported as supported | host-wol-verdict.ts: `? FIRMWARE_UNVERIFIED` -> `? ({ value: 'supported', ..., evidence: { kind: 'os-probe', ... } })` | yes, 1 file, 1/1 | `vitest run host-wol-verdict.test.ts`, exit 1, `FAIL ... > never yields supported over the whole ...` (`of 26 rows: expected [ 'win: enabled and armed', ...(2) ] to deeply equal []`) plus 3 table rows; `Tests 4 failed \| 26 passed (30)` | diff-quiet 0; rerun exit 0, `Tests 30 passed (30)` |
| P19-M5 admin local guard removed | rpc/methods/host-wake-admin.ts: `if (!isLocalRpcCaller(ctx)) {` -> `if (false && ...)` | yes, 1 file, 1/1 | `vitest run rpc/methods/host-wake-admin.test.ts`, exit 1, 8 `refuses a ...` rows (`expected null to be 'remote_caller_refused'`, `expected 'wake_target_unknown' to be 'remote_caller_refused'`); `Tests 8 failed \| 19 passed (27)` | diff-quiet 0; rerun exit 0, `Tests 27 passed (27)` |
| P19-M6 effect-time device authority ignored (first check and pre-send re-check share `authorizeCaller`) | wake-broker.ts: `const verdict = authority.authorize(caller.token)` -> `const verdict = { ...authority.authorize(caller.token), ok: true as const, deviceId: caller.deviceId }` | yes, 1 file, 1/1 | `vitest run wake-broker-revoke-in-process.test.ts rpc/methods/host-wake.test.ts`, exit 1, `FAIL wake-broker-revoke-in-process.test.ts > ... a revoked ...` at line 135 (received `wake_grant_missing`, expected `wake_device_revoked`) and `FAIL host-wake.test.ts > refuses a revoked device with wake_device_revoked, never the latch reason` (`expected true to be false`: the request succeeded), plus `refuses an unknown token and a token for another device`; `Tests 3 failed \| 9 passed (12)` | diff-quiet 0; rerun exit 0, `Tests 12 passed (12)` |

Observed detail on M6: in the in-process leg the revoke's grant purge (D-10) still stopped a second frame; the
mutant was caught by the refusal code there, and by an accepted request in the unit row where the grant survives.
The plan expected a second frame in-process; that did not happen, because the purge is a second, independent guard.

The first M1 attempt hit a driver defect (`pnpm.ps1` joined both test paths into one filter, `No test files found`);
it was not counted. The tree was restored (diff-quiet 0) and M1 was re-run with `pnpm.cmd`, recorded above.

The live leg's assertions would also catch M1-M3 (grant refusal, replay and stage law are asserted live), but
rebuilding out/ on GEX44 per mutant was not run: **not claimed**.

Gates after the drills (final tree): 6 unit files `Tests 85 passed (85)`; `check:host-card-claims` exit 0
(`22 labels classified, 2 controls classified, 598 host RPC methods known, ...`); `check:durability-contracts` exit 0
(`22 contract(s) ... no new ones`); `check:recurring-work` exit 0 (`total=236 ... debt=0`); `git diff --quiet -- src
config mobile` exit 0.

## LAN Product Reality: OWNER_BOUND

What is missing, by step:
- **(a) OS arming of the NIC.** Measured as already done on this laptop: the Realtek PCIe GbE Family Controller
  (`Ethernet`) has WakeOnMagicPacket Enabled and is in `powercfg /devicequery wake_armed`, which is why the verdict is
  `unknown/firmware_unverified`, not `needs-owner-setup/os_not_armed`. Not owed today. If a driver update disarms it,
  the probe will read `os_not_armed` and the fix is an elevated
  `powercfg /deviceenablewake "Realtek PCIe GbE Family Controller"`.
- **(b) Firmware.** BIOS "Resume by PCI-E / LAN" on and ErP off. The OS cannot read this, so the verdict is at best
  `firmware_unverified`.
- **(c) An always-on LAN node** running `orca serve --wake-broker`. The measured LAN has none, and the broker cannot
  run on the sleeping target.

Ordered Owner procedure that would turn SC3 to PASS:
1. Do (b) and (c); confirm (a) still reads armed.
2. On the node: `orca wake target add --mac <the PC's MAC> --broadcast <the subnet-directed broadcast, e.g. 192.168.1.255> --label <name>`.
3. Pair the phone with the node; read the phone's device id (desktop Settings, or the device's own `status.get`
   `pairedDeviceId`); `orca wake grant add --device <id> --target <targetId>`.
4. Put the PC to sleep.
5. From a client on the LAN, `host.wake.request`; expect requested, authorized, packet-sent.
6. Observe host-announced (the PC's own `status.get` answer after packet-sent) and runtime-ready, then fresh terminal
   output from the woken PC.

Nothing in this phase slept, armed or reconfigured the Owner's PC.

## D-02 note

`supported` is never emitted in phase 19 (M4 CAUGHT). The observed-wake evidence channel (a host-announced resume
after a packet this broker sent) is phase 20 work, together with the deferred pre-suspend announcement.

## D-13: the mobile Wake control is DEFERRED

Reasons (19-RESEARCH section 6):
1. **Cross-host routing.** The card belongs to the sleeping target, but the RPC goes to a different paired host (the
   broker), so the phone must map the target's card to (broker host, targetId): new phone state across hosts.
2. **A new stage label family** (`wake.requested`, ...) and its vocabulary entry in the checker.
3. **A checker weakening.** The first effect control disables the card-wide effect-wording check in
   `check-host-card-claims.mjs`; doing it safely needs a per-control scope and a new mutant.
4. **Testing cost.** Mobile tests run only on GEX44 (D-16).

The SCRIPTED CLIENT drives `host.wake.*` instead. `capability.can-wake-lan` still says the card has no wake control,
and `check:host-card-claims` still classifies 2 controls, both navigation.

**Closed by phase 21** (2026-10-28, appended; the text above is the phase 19 record). The four reasons were closed by
21-01/21-02/21-05 (routing by hostKey binding), 21-03/21-04 (the `wake` label family), 21-03 (per-control effect
scope) and 21-04/21-05/21-06 (GEX44 runs). The control was built at UNIT and GEX44 render level, with seven mutants
CAUGHT. The phone leg is owed: see `21-VERIFICATION.md` ("D-13 closure") and STATE.md Deferred Verification row 21.

## Named residuals

- No CLI device listing (19-04): a serve-only broker has no Settings window, so the Owner reads the id from the
  device's own `status.get`.
- Windows multi-NIC: a limited broadcast (`255.255.255.255`) leaves through one interface only, hence the CLI hint
  for the subnet-directed broadcast.
- grantAdd on an unavailable registry stores a grant that authorizes nothing (19-04); the effect re-judges.

## Decision traceability

| Decision | Where it is held | Evidence |
|---|---|---|
| D-01 read-only probe per platform | `host-wol-probe.ts`, `host-wol-verdict.ts` | 19-01 tables; MEASURED live probe here |
| D-02 firmware unreadable; never supported from config | `windowsWolVerdict` / `linuxWolVerdict` / `darwinWolVerdict` | 26-row table; P19-M4 CAUGHT; live verdict firmware_unverified |
| D-03 off the hot path, no new timer | request-driven single-flight probe | `check:recurring-work` debt=0, total 236 unchanged |
| D-04 explicit broker role, `wake_broker_disabled` otherwise | `--serve-wake-broker` / `startWakeBroker` | live no-flag host: capability absent, `wake_broker_disabled` x3 |
| D-05 targets only on the broker, MAC never to the phone | `host.wake.admin.*` local-only, phone methods return id + label | live: 13 phone replies with no MAC shape (positive control on the admin reply); P19-M5 CAUGHT |
| D-06 standard frame over dgram | `buildMagicPacket`, `sendMagicPacketUdp` | live: 102 bytes, 6x0xFF + 16xMAC at a loopback listener |
| D-07 grant per device per target, local Owner act | store grants, `grantAdd` local-only | live B refused `wake_grant_missing`; P19-M1, M5 CAUGHT |
| D-08 judged at the effect (device, grant, target) | `judge` at request and at send | live refusals; in-process `wake_device_revoked`; P19-M1, M6 CAUGHT |
| D-09 dedupe 60 s, adoption 10 s | `replays`, `adoptable` | live replay +1 frame for the pair, adoption at 6047 ms +0; P19-M2 CAUGHT |
| D-10 crash-durable targets and grants; revoke drops grants | `wake-broker-store.ts`, contract, `dropWakeGrantsAfterRevoke` | `check:durability-contracts` exit 0; live relaunch kept the target and A's grant (`enabled (1 targets)`); in-process purge (M6 detail) |
| D-11 staged, never "woken" | `HOST_WAKE_BROKER_STAGES`, `composeWakeProgress` | live stages end at packet-sent with no target answer; P19-M3 CAUGHT |
| D-12 additive behind `host.wake-broker.v1` | `wakeBrokerRuntimeCapabilities()` | live capability present with the flag, absent without |
| D-13 Wake control only with a real RPC, else deferred | not built | DEFERRED, reasons above; claims gate 2 controls |
| D-14 scripted proof and mutants | `wake-broker-scripted-client.live.test.ts`, mutant table | live leg passed; six mutants CAUGHT and RESTORE_VERIFIED |
| D-15 LAN Product Reality OWNER_BOUND | this file | steps a (measured armed), b, c named; procedure above |
| D-16 out/ on GEX44 disposable; single files here; never push | `19-gex44-build-out.ps1/.sh` | sha256 match both ends, `TEARDOWN procs=0 root=absent`, `NONE_P19`; no push, no merge |
