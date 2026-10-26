# STATE: Phone control of a live Orca X session, then DWS convergence

## Current Position
Phase: 4 of 10 -- Ready to plan. Phase 3 complete 2026-10-26 (2/2): src/main/runtime/runtime-rpc-mobile-reconnect-revocation.test.ts, mutants M4, M5, M6b, M7 CAUGHT, M6 equivalent (handles retained per PTY incarnation).
Earlier: Phase 1 complete 2026-10-26 (3/3). Phase 2 complete 2026-10-26 (2/2): oracle src/shared/terminal-fresh-output-oracle.ts, scope proof src/main/runtime/rpc/terminal-send-mobile-scope.test.ts, mutants M1-M3 CAUGHT. Owed: tsc not run on the laptop.
Phase 3 lead (read-only, 2026-10-26): revocation-at-effect already exists (src/main/runtime/device-authorization.ts assertDeviceStillAuthorized; runtime-rpc.ts:1118 binary frames, :1756 RPC) and is characterized in src/main/runtime/runtime-rpc-revoked-device-effect.characterization.test.ts (row 58). Phase 3 work = reconnect identity (same session id, no PTY growth) plus a terminal.send-specific revoked leg.

## Decisions (unattended)
- 2026-10-26 Phase 1 RED is a unit test, not e2e: the laptop cannot build for the headless paired harness. Safe: reversible, internal.
- 2026-10-26 Phase 2 adds no wire field for host scope; per-host connection + runtime-local handle map already fences it. Safe: no wire change, proven by mutants.
Base: rb-live c1f33f4d4e (pushed 2026-10-19), branch mobile/phone-control, worktree C:\owx-pc on the Owner's laptop (C:\Users\Jacobo).
Last activity: 2026-10-26 16:00 -- mission ownership moved to the C:\Users\Jacobo laptop (Owner: "go here"). The arming pane on the C:\Users\User machine (worktree orca-phone-wt) stays idle and is NOT a writer. The previous DWS milestone (phases 1-12) is archived in rb-live history c1f33f4d4e.

## Laws (binding)
- You are already in the work tree. Do not call EnterWorktree or ExitWorktree.
- Never push, never merge to main. Pushing is Owner-only.
- Do not touch the primary checkout (C:\Users\Jacobo\Desktop\Cursor Projects\Orca X), C:\ox, or any other worktree.
- Fresh output proves a live-control claim. Terminal history containing the nonce proves nothing.
- UNKNOWN is never zero and never offline. A negative needs a positive control that could have seen the object.
- DWS extends the mobile RPC owner. Do not build a second remote-control transport.
- Emulator evidence is labelled emulator. DONE for a GSD unit is not PASS for a DWS row.
- Laptop: 8 GB, about 2.5 GB free. Single vitest files run here (measured 7 s). No emulator, no full build, no full suite here: heavy runs go to GEX44 (ssh alias gex44, ~49 GB free), in a disposable root, never in an existing ~/orca-* tree.
- node_modules in this worktree is a junction to C:\ox\node_modules (root lockfile identical). mobile/node_modules is not installed yet.
- Use git through PowerShell. No Bash for git on this host.

## Facts measured 2026-10-26 on this laptop (re-verify before relying)
- DWS verifier (node config/scripts/check-dws-completeness.mjs) at f758bd57f: 48 of 76 PASS, ABSENT 10, PARTIAL 18, verdict CONTRACT INVALID. Rows 59, 70, 73 PASS. Rows 12, 33 PARTIAL (blocked on UWCP control verbs, CPP stages after S4-22). Row 75 PARTIAL (rows 64, 66 live legs partial). Row 39 ABSENT, OUT-OF-PROGRAM since 2026-10-18 (stale-write refusal rests on UWCP log ordering).
- Old GEX44 tree dws/rebaseline ca3a66869 gives 22 of 76; it is stale. No GEX44 ~/orca-* tree is on this branch.
- Mobile terminal slices 1-4 (composer and key row, header and search, host and runtime pickers, output card) are on this branch; device-gated.
- Host RPC: terminal.list/read/send/subscribe/multiplex/create/stop in src/main/runtime/rpc/methods/terminal.ts; agent-session.ts for Agent turns. terminal.send scopes by terminal handle (stale -> terminal_handle_stale) and a per-client input lock; host scope is the per-host connection.
- Mobile caller of terminal.send: mobile/app/h/[hostId]/session/[worktreeId].tsx. Headless paired harness: tests/e2e/helpers/headless-paired-runtime-host.ts.
- No existing e2e drives a paired phone into a live laptop PTY with a fresh-output oracle.
- Orca X desktop is running on this laptop (the Windows host for Phases 2-7).
- GEX44 DWS units X05, X06, X16, X18, X19 sit at OWNER_BOUNDARY (AMR cap); classify, do not blindly relaunch.

## Owner-only
Physical phone pairing; interactive provider login and real quota spend; push or merge.

## Token budget
Mission about 6M: scan 0.4M (0.2M spent), implementation 2M, tests and Product Reality 2.3M, handoff reserve 1.3M.
