# Phase 20 plan check (2026-10-27)

Plans checked: 20-01..20-05. Result: 0 blockers, 0 warnings, 3 info.

## Coverage
- SC1: 20-01 (UNIT in-process relay, row L, P20-L1/L2), 20-02 (can-wake-remote pinned, option B), 20-03 (wake-proxy-available UNIT unrendered), 20-05 (M3 OWNER_BOUND with ordered procedure).
- SC2: 20-02 (measured probe, never supported), 20-03 (contract + test-only double + sweep with positive and station controls), 20-05 (M4 HARDWARE_BOUND).
- SC3: K/M 20-03, L 20-01, 12 mutants (20-01 x2, 20-04 x10), G6 20-04, vault lesson / UKDL proposal / handoff / fresh-agent questions 20-05.
- D-01..D-14 all claimed and acted on; deferred items stay deferred.

## Structure
Every task has read_first, concrete action, acceptance criteria; every <automated> has a <fails_when>. Tasks per plan 3/3/2/3/3.

## Same-wave disjointness (20-01, 20-02, 20-03)
No shared path in files_modified. Plans run sequentially (one git index).

## Premises verified in code
- mobile-socket-wiring.ts:97 attachTransport, :165 relay binding check (exact text).
- wake-broker.ts:137 `const verdict = authority.authorize(caller.token)`.
- runtime-rpc.ts:660 getE2EEKeypair, :664 getMobileSocketWiring, :706 revokeMobileDevice, :750 createPairingOffer.
- rpc/relay-transport.ts:45 CloudRelayTransport, :79 metadataFor; relay-http-client.ts:68 deriveRelayHostId; simulated-mobile-e2ee-v2-peer.ts:17; desktop-relay-service.ts:60-61.
- secure-path-windows-acl.ts:139 private getWindowsSystemToolPath.
- host-availability.ts:190 REASON_PATTERN.
- host-autostart-probe.ts:78 capabilityFromStatus, supported at :87, 'os-probe' quoted :79 (G6 R5 satisfiable); producer quotes 'relay-reported' / 'host-announced'; describe() hard-codes can-wake-remote :106-110, oob :112.
- check-host-card-claims.mjs: stripComments :199 (private; plan exports it), async main :472-497 guarded at :499; .oxlintrc .mjs cap 600 (:151-154).

## Honesty
No UNIT/SCRIPTED leg labelled M3; can-power-on-oob and can-wake-remote never supported (tables, G6, P20-O1/W1); double sweep with positive + station control; no Owner-PC effect; loopback UDP; no push; mutants restored by byte copy + sha256 + diff-quiet, drivers in temp dir.

## ISSUES FOUND
1. info, 20-02 Task 1: GREEN leaves typecheck:node red until Task 3 adds `oob` to index.ts (disclosed). Fix: optionally move the index.ts `oob` addition into Task 1.
2. info, 20-01 Task 3: P20-L1 plant uses `caller.deviceId` (field not verified). Vitest does not typecheck, and the plan already accepts wake_grant_missing as the caught code. Fix: quote the caller type in the MUTANTS row.
3. info, 20-04 Task 1: where the producer clause goes in the success line is not specified; the test asserts a substring only. Fix: state the exact final line.

Advisory only - no revision required.
