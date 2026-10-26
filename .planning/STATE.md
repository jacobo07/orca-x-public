# STATE: Phone control of a live Orca X session, then DWS convergence

## Current Position
Phase: 1 of 10 -- Ready to plan.
Base: rb-live c1f33f4d4e (pushed 2026-10-19), branch mobile/phone-control, this worktree orca-phone-wt.
Last activity: 2026-10-26 Reality Scan done by the arming pane; Owner approved the plan with "y". The previous DWS milestone (phases 1-12) is archived in .planning/archive-20261026-dws-rb/.

## Laws (binding)
- You are already in the work tree. Do not call EnterWorktree or ExitWorktree.
- Never push, never merge to main. Pushing is Owner-only.
- Do not touch C:\Users\User\Apps\orca-rb-live-wt (it holds uncommitted .planning edits from another writer) or the primary checkout.
- Fresh output proves a live-control claim. Terminal history containing the nonce proves nothing.
- UNKNOWN is never zero and never offline. A negative needs a positive control that could have seen the object.
- DWS extends the mobile RPC owner. Do not build a second remote-control transport.
- Emulator evidence is labelled emulator. DONE for a GSD unit is not PASS for a DWS row.
- Laptop RAM is about 1.7 GB free: no emulator and no full build unless free RAM allows; heavy runs go to GEX44.
- Use git via C:\Program Files\Git\cmd\git.exe in PowerShell. No Bash for git on this host.

## Facts measured 2026-10-26 (re-verify before relying)
- DWS verifier on rb-live: 48 of 76 PASS, ABSENT 10, PARTIAL 18. Rows 59, 70, 73 PASS. Row 33 PARTIAL. Row 12 PARTIAL. Row 75 PARTIAL. Row 39 ABSENT, marked OUT-OF-PROGRAM on 2026-10-18.
- Old GEX44 tree dws/rebaseline ca3a66869 gives 22 of 76; it is stale.
- Mobile terminal slices 1-4 (composer, header and search, host and runtime pickers, output card) shipped 2026-10-19 on rb-live; notes say device-gated.
- Host RPC: terminal.list, read, send, subscribe, multiplex, create, stop in src/main/runtime/rpc/methods/terminal.ts; agent-session.ts for Agent turns.
- No existing e2e found that drives a paired phone into a live laptop PTY with a fresh-output oracle.
- GEX44 DWS units X05, X06, X16, X18, X19 sit at OWNER_BOUNDARY (AMR cap); classify, do not blindly relaunch.

## Owner-only
Physical phone pairing; interactive provider login and real quota spend; push or merge.

## Token budget
Mission about 6M: scan 0.4M, implementation 2M, tests and Product Reality 2.3M, handoff reserve 1.3M.
