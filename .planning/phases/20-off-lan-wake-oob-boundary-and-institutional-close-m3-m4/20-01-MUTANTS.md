# 20-01 mutant drills: P20-L1, P20-L2 (relay path, UNIT in-process relay)

Run 2026-10-28 on the laptop, real tree `C:\owx-haf` at `489b4f555` (branch `mobile/host-availability`). These are
unit-level drills over the UNIT in-process relay leg (loopback relay cell, real `CloudRelayTransport`, real
`OrcaRuntimeRpcServer`). They are not M3 evidence.

## Protocol (19-VERIFICATION, restore by byte copy)

Driver `mutant.ps1` plus one wrapper per drill (`drill-L1.ps1`, `drill-L2.ps1`), all in the job tmp directory
`C:\Users\<owner>\.claude\jobs\fd0cc958\tmp\`, never in the repo. Per drill:

1. `git diff --quiet -- <file>` exit 0; the file's bytes are copied to the tmp directory and their sha256 recorded.
2. The anchor occurs exactly once (`Select-String -SimpleMatch` line count 1 and regex text count 1).
3. Plant by that single replacement (same encoding, BOM preserved if present). PLANT_CONFIRMED means
   `git diff --name-only` names only that file and the planted text is present.
4. Catcher: `cmd /c "pnpm.cmd exec vitest run --config config/vitest.config.ts src/main/runtime/wake-broker-relay-dispatch.test.ts"`.
   CAUGHT means a non-zero exit with the expected row named FAIL.
5. Restore in a `finally` block by copying the saved bytes back (not `git checkout`). RESTORE_VERIFIED means the
   sha256 equals the pre-plant hash, `git diff --quiet -- <file>` exits 0, and the catcher exits 0 again.

## Caller type behind the P20-L1 plant (plan-check info 2)

`src/main/runtime/wake-broker.ts:67`:

```ts
export type WakeCaller = { token: string | undefined; deviceId: string | undefined }
```

`caller.deviceId` exists. `authorizeCaller` has already refused an empty one at `:134`
(`if (!caller.token || !caller.deviceId) {`), so at the plant site it is the dispatch context's `pairedDeviceId`
(`rpc/methods/host-wake.ts:30-32`, `{ token: ctx.clientId, deviceId: ctx.pairedDeviceId }`). The plant forces the
verdict to `ok` for that same device id, which is exactly "effect-time device authority ignored". Its static type
(`string | undefined`) would fail `tsc`, but vitest does not typecheck, and the mutant only lives during the drill.

## Drills

| Mutant | Plant (file: anchor -> plant) | PLANT_CONFIRMED | CAUGHT (command, exit, decisive line) | RESTORE_VERIFIED |
|---|---|---|---|---|
| P20-L1 effect-time device authority forced ok (P19-M6 shape, reached through the relay) | `src/main/runtime/wake-broker.ts:137`: `const verdict = authority.authorize(caller.token)` -> `const verdict = { ...authority.authorize(caller.token), ok: true as const, deviceId: caller.deviceId }` | yes: anchor line hits 1, text hits 1; `git diff --name-only` = `src/main/runtime/wake-broker.ts` only; plant present; `1 file changed, 1 insertion(+), 1 deletion(-)` | CAUGHT: catcher exit 1, `FAIL wake-broker-relay-dispatch.test.ts > ... > refuses a revoke inside the dispatch window at the effect, then refuses the next relay frame` at `:251:22`, received `"code": "wake_grant_missing"`, expected `"code": "wake_device_revoked"`; `Tests 1 failed \| 8 passed (9)` | RESTORE_VERIFIED: sha256 `A3617A94A9EFABE162BD8E0CDAD6CDF21EFF5265185149F226651D884EFBFE53` before = after; `git diff --quiet` exit 0; catcher rerun exit 0, `Tests 9 passed (9)` |
| P20-L2 relay device binding skipped | `src/main/runtime/rpc/mobile-socket-wiring.ts:165`: `if (metadata.transport === 'relay' && metadata.relayDeviceId !== device.deviceId) {` -> `if (false && metadata.transport === 'relay' && metadata.relayDeviceId !== device.deviceId) {` | yes: anchor line hits 1, text hits 1; `git diff --name-only` = `src/main/runtime/rpc/mobile-socket-wiring.ts` only; plant present; `1 file changed, 1 insertion(+), 1 deletion(-)` | CAUGHT: catcher exit 1, `FAIL wake-broker-relay-dispatch.test.ts > ... > never readies a relay leg bound to phone-b that presents phone-a's token, and wakes nothing` at `:196:32` (`await expect(crossed.ready).resolves.toBe(false)`), `AssertionError: expected true to be false`; `Tests 1 failed \| 8 passed (9)` | RESTORE_VERIFIED: sha256 `88405E14A19012C87AECE4E76931BA0DAC23205AF16F6C2DC230D94CC70B4C59` before = after; `git diff --quiet` exit 0; catcher rerun exit 0, `Tests 9 passed (9)` |

What each drill showed:
- **P20-L1.** As in 19 (P19-M6), the revoke's grant purge (D-10) is a second, independent guard, so with authority
  forced ok the in-window request is refused `wake_grant_missing` and still sends no frame. The relay row catches the
  mutant by its refusal code: the effect-time device judgement is what produces `wake_device_revoked`, and the plan
  accepted either outcome as the visible symptom.
- **P20-L2.** With the binding check skipped, phone-a's token completes E2EE on a relay leg the outer relay bound to
  phone-b. The row fails at its first assertion (ready became true). The unmutated tree refuses that leg with an
  encrypted `e2ee_error` at the auth step (the row's station control: `endedIn: 'e2ee-authenticated'`,
  `cause: 'e2ee_error'`). That proves the server judged the binding; a slow splice timing out is ruled out.

Driver defects: none. Both drills ran once; no run was discarded.

Exit code of `git diff --quiet -- src/main/runtime/wake-broker.ts src/main/runtime/rpc/mobile-socket-wiring.ts` after both drills: 0
