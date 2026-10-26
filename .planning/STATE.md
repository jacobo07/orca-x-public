# STATE: Phone control of a live Orca X session, then DWS convergence

## Current Position
Phase: 10 of 10 -- Ready. Phases 5, 7 and 9 are PARTIAL (human_needed, see Deferred Verification). Phase 8 ran its Orca-side legs ahead of 7 under the unattended rule.
Base: rb-live c1f33f4d4e (pushed 2026-10-19), branch mobile/phone-control, worktree C:\owx-pc on the Owner's laptop (C:\Users\Jacobo).
Last activity: 2026-10-26 17:15 -- worker epoch 2: phases 1-4, 6, 8 complete (1e828f057, 0a9b58881, 8e6e78c7b, 7c268fa18, a8380b51a, phase 8 commit follows); phase 5 behavioural half (f80287311); phase 7 headless leg (27ee95e2a). Mission ownership moved to this laptop 16:00 (Owner: "go here"); the arming pane on C:\Users\User (worktree orca-phone-wt) stays idle and is NOT a writer. Previous DWS milestone archived in rb-live history c1f33f4d4e.

## Completed phases (evidence in .planning/phases/NN-*/)
- Phase 1 (3/3): row reasons and owner map in 01-OWNERS.md; RED oracle test.
- Phase 2 (2/2): oracle src/shared/terminal-fresh-output-oracle.ts; scope proof src/main/runtime/rpc/terminal-send-mobile-scope.test.ts; M1-M3 CAUGHT.
- Phase 3 (2/2): src/main/runtime/runtime-rpc-mobile-reconnect-revocation.test.ts; M4, M5, M6b, M7 CAUGHT; M6 equivalent (handles retained per PTY incarnation). Revocation authority: device-authorization.ts assertDeviceStillAuthorized (runtime-rpc.ts:1118 frames, :1756 RPC).
- Phase 4 (2/2): mobile/src/worktree/host-switch-row-isolation.test.ts; GEX44 34/34, P4-M1..M3 CAUGHT, root torn down.
- Phase 5 (1/2, human_needed): mobile/src/session/use-mobile-terminal-paste.test.ts; GEX44 44/44; P5-M1b, M2, M3 CAUGHT; tokens from mobile-theme.ts with positive control. Captures NOT done.
- Phase 6 (2/2): measured, no code; provider leg EXTERNAL_BLOCKED.
- Phase 7 (0/2, human_needed): tests/e2e/headless-paired-mobile-terminal-fresh-output.spec.ts + tests/e2e/helpers/mobile-protocol-client.ts; GEX44 built app --serve under xvfb: 1 passed, P7-M1 CAUGHT by the oracle. Headless Linux + scripted phone protocol only.
- Phase 8 (2/2): scope test extended (stale desktop+mobile writes refused, phone floor accepted, desktop refused); relay tally + gate 13/13; placement 69/69; P8-M1..M6 CAUGHT. X units: X05/X16/X18 code on branch, PARTIAL pending two-host runs; X06/X19 NOT on this branch (need a port from GEX44 ~/missions/dws-exec). DWS matrix unchanged.
- Phase 9 (1/2, human_needed): Continue here refuses a dirty or unreadable source before restore (project-working-set-continue-source-state.ts); 86/86; P9-M1..M3 CAUGHT. Row 75/70 two-host leg not run. Workstream identity not carried (UWCP absent).
- tsc: web project (config/tsconfig.tc.web.json) exit 0 on the laptop 2026-10-26; node project still owed.

## Deferred Verification
| Phase | State | Resume |
|-------|-------|--------|
| 5 | verification_deferred_human | /gsd-verify-work 5 (captures: keyboard open/closed, selector open, long names, many runtimes; Android 14 emulator on C:\Users\User or a paired phone) |
| 7 | verification_deferred_human | /gsd-verify-work 7 (Windows app + paired phone or labelled emulator; run the headless spec on Windows; live revoke from Settings) |
| 9 | verification_deferred_human | /gsd-verify-work 9 (row 75/70 on Windows + GEX44 with a mobile controller; needs the OWNER DECISION below or a phone) |

## OWNER DECISION NEEDED
- Q (2026-10-26, phase 7): may a worker pair a scripted phone-protocol client to the Owner's running Windows Orca X (adds an authorized device; revoked at the end of the run) to get the Windows leg and a live Settings revoke without a physical phone? Options: (a) yes, scripted client on Windows, labelled scripted; (b) no, wait for a physical phone or the emulator machine; (c) skip the Windows leg. Worker pick: (a), because it is reversible by revocation and keeps the phone itself as the only Owner step left. Not acted on: it changes the security posture of the Owner's live install.

## Blocked (resource)
- Phase 5 captures: no emulator here (laptop law) and GEX44 cannot run one (/dev/kvm root:kvm, kobii not in kvm, no Android SDK; joining kvm needs root on a shared host).

## GEX44 mobile test recipe
git bundle HEAD -> scp to /tmp/orca-phone-pN-<ts>; PATH from ~/orca-env/env.sh (node24 v24.21.0, pnpm 10.24.0); `pnpm install --frozen-lockfile --ignore-scripts` in mobile/; script refuses any root outside /tmp/orca-phone-p*; tear down after. Ship scripts as no-BOM LF files via `ssh gex44 bash -s < file`.

## Decisions (unattended)
- 2026-10-26 Phase 1 RED is a unit test, not e2e: the laptop cannot build for the headless paired harness. Safe: reversible, internal.
- 2026-10-26 Phase 2 adds no wire field for host scope; per-host connection + runtime-local handle map already fences it. Safe: no wire change, proven by mutants.
- 2026-10-26 Phase 4 runs mobile tests on GEX44 rather than installing mobile deps on the laptop (RAM law). Safe: disposable root, torn down.
- 2026-10-26 Phase 9 criterion 2: "not offered" implemented as a refusal at the effect on a dirty or unreadable source (fail closed); Workstream identity left unclaimed because UWCP is absent. Safe: reversible, internal, no wire change.
- 2026-10-26 Removed a stale worktree index.lock (no live git process, 262 s old; backup in job tmp). Safe: scratch file, backed up.

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
