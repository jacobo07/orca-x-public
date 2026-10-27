# Phase 19 plan check (2026-10-27)

Coverage: SC1 (19-01, 19-05), SC2 (19-02/03/04/05), SC3 OWNER_BOUND (19-05). D-01..D-16 all mapped; D-13 control deferred with reason (19-01 objective, 19-05 Task 3).
Waves: no files_modified overlap in wave 1 (19-01/19-02) or wave 2 (19-03/19-04).
Premises verified: errors.ts:82/138, runtime-rpc.ts:238/719/1198, args.ts:16, serve-autostart.ts:146, local-rpc-caller.ts:8, device-authorization.ts:17, device-registry.ts:186, producer :106/:111, index.ts:440/2049/3401/3403/3504/3506, parity + effect-class + allowlist tests exist.
Every <automated> has <fails_when>. No timers, no max-lines disables, no vague names, no push, no Owner-PC effect.

## ISSUES FOUND
1. BLOCKER 19-05 Task 2: no local revoke path is reachable over the runtime transport. revokeMobileDevice/revokeRuntimeAccess are reachable only through Electron IPC (src/main/ipc/mobile.ts:246,254); no rpc/methods file calls a device revoke. The live "refused for a revoked device" step (D-14) cannot run.
2. WARNING 19-03 Task 3: runtime-rpc.ts:1057 (discardPendingMobilePairingDevice) removes devices without going through revokeAndTerminate, so their grants are not purged (D-10).
3. WARNING 19-02 Task 1: method-level `device_revoked` reuses the dispatch/E2EE latch reason (mobile-e2ee-auth-validation.ts:34-67). The mobile-behaviour check runs only in 19-03, after the code has shipped.
4. INFO 19-02 Task 3: D-10 names durable-file-write.ts; the plan uses writeDurableSecureJsonFile (secure-file.ts:95). Confirm it reaches the barrier.

## Re-check after revision (2026-10-27)
- Issue 1 RESOLVED: 19-03 Task 3 adds wake-broker-revoke-in-process.test.ts (in files_modified and verify). It uses a real RuntimeRpcServer, revokeMobileDevice (runtime-rpc.ts:701) and a loopback listener. 19-05 labels that row UNIT in-process, says the live revoke is not claimed, and adds P19-M6. The mutant count is six everywhere in 19-05.
- Issue 2 RESOLVED: discardPendingMobilePairingDevice (:1057) now purges grants, and the wiring test asserts it.
- Issue 3 RESOLVED: the code is wake_device_revoked across 19-02, 19-03 and 19-05, and HOST_WAKE_REFUSAL_CODES no longer holds device_revoked. The disjointness grep now runs in 19-02 Task 1.
- Issue 4 RESOLVED: 19-02 Task 3 checks the barrier, with writeFileDurableSync as the fallback and a syscall-order assertion.
- Wave disjointness still holds (the new file is only in 19-03; 19-04 is unchanged).
- INFO (new): 19-02:150 points at mobile/src/transport/mobile-e2ee-auth-validation.ts, which does not exist. The real file is src/main/runtime/rpc/mobile-e2ee-auth-validation.ts. The grep over mobile/src and src/shared still covers it.
