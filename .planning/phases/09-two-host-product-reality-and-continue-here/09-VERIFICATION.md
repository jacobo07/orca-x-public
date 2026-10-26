---
phase: 09-two-host-product-reality-and-continue-here
status: human_needed
verified: 2026-10-26
score: 1/2
human_verification:
  - "Physical phone (or labelled emulator) switching hosts in the app's host picker. The run below is SCRIPTED CLIENT: it proves the host side of two-host scoping, not the phone UI."
  - "Revoke the witness device left from phase 7 (Owner's Orca X > Mobile, 'Mobile 26/10/2026', paired ~18:19). Revocation is renderer-only; no host-local RPC exists."
---

# Phase 9 Verification

| # | Success criterion | Evidence | Result |
|---|---|---|---|
| 1 | Row 75 re-measured on Windows and GEX44 with a mobile controller, or PARTIAL with the named residual | Two-host live leg, 2 of 2 runs passed, 2026-10-26 20:24 and 20:26 (below) | MET as re-measure (SCRIPTED CLIENT). Row 75 stays PARTIAL: its own residual (rows 64 and 66 live only in part) is untouched by a controller |
| 2 | Continue here preserves project identity, dirty state and Workstream identity, or is not offered | project identity: existing target resolution; dirty/unknown source refused before restore, 86/86, P9-M1..M3 CAUGHT | PARTIAL: dirty-state half PASS; Workstream identity not carried (UWCP absent), not claimed |

No DWS row changes state.

## Two-host live leg (SCRIPTED CLIENT)

`src/main/runtime/mobile-live-two-host-leg.live.test.ts`, one scripted phone-protocol client (E2EE, mobile-scoped pairing) holding two host connections at once. Not a phone, not an emulator.

- Host A: Windows laptop JACOBO-PC, worktree build of e7fd002fd run by the worktree's Electron in `--serve` mode, disposable profile and home (E2E home contract), loopback 127.0.0.1:47392, Windows PowerShell PTY. It is not the Owner's installed instance: the packaged app pins userData to the Owner's profile and lock, and pairing a running desktop needs a UI click.
- Host B: GEX44, same HEAD, `--serve` under xvfb, loopback 127.0.0.1:47391, reached only through an `ssh -L` tunnel the test owns.
- Projects registered host-locally (`repo.add` over the runtime's own pipe/socket, as the orca CLI does); `repo.add` stays host-only.

Observed, both runs:
- Send to A → `HOST JACOBO-PC win32`, oracle FRESH; B's terminal read since its cursor (not truncated) has no `marker nonce`.
- Send to B → `HOST … linux`, FRESH; A has no `marker nonce`.
- Each host refuses the other's terminal handle; A re-listed keeps the handle and is FRESH again.
- Ticker started on B; tunnel killed (port closed, B gives no reply within 10 s) while a send on A is FRESH; after 15 s the tunnel reopens and B re-authenticates with the same device token: `terminal.list` handle/ptyId pairs identical, ticks 0 → 16 (≥ 13 required), so the remote process ran through the cut; Ctrl-C stops it; a final send on B is FRESH.
- All created terminals closed in `finally`.

Instrument check: the first attempt read ABSENT on host A while the command had run (below), so the oracle could and did return the other answer. Oracle mutants on the laptop: P9-M4 (glue rule removed) and P9-M5 (rule widened to `includes`) each PLANT_CONFIRMED, CAUGHT (1 of 9 red), RESTORE_VERIFIED; oracle + scope tests 15/15; `tsc -p config/tsconfig.node.json` exit 0.

## Findings
- Windows ConPTY `terminal.read` lines are not screen lines. ConPTY repaints with cursor moves, and the tail is the ANSI-stripped stream split on `\n`, so PSReadLine's redraws pile up on one line and the command's output is glued to the end of the echo (`…process.platform)"ORCA-2H-… nonce-…`). The line-equality oracle reported ABSENT for a command that ran. Oracle extended narrowly: a line ending in the exact sent text followed by the expected line is FRESH (the echo alone cannot contain it); control tests refuse a partial echo and arbitrary prefixes. The product defect (agents and the Agent prompt read this tail on Windows hosts) is not fixed here.
- `--serve-project-root` only feeds `--serve-recipe-json`; it does not register the project, so a fresh serve host lists no repos until `repo.add`.
- The phase 7 witness device was never revoked (Owner's device list, read-only, 2026-10-26 20:28: one device, no revokedAt). Owner action above.

## Teardown
Host A process tree killed (pid verified by command line), port 47392 closed, disposable profile deleted; GEX44 serve killed (7 pids, 0 left), port 47391 closed, `/tmp/orca-phone-p*` count 0; pairing codes and bundles deleted locally; no ssh tunnel left.
