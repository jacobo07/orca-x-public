# Phase 20 fresh-agent test (D-12)

A read-only agent with no chat context answers the questions below from durable files under `C:\owx-haf` only, citing
`file:line` for every fact. The orchestrator dispatches it after the 20-05 commits and scores it with the rubric. This
plan did not dispatch it.

## Questions

**Q1** Which worktree and branch hold this work, and what are at least five of the binding laws an agent must obey there?

**Q2** What is the verification status of phases 17, 18, 19 and 20, and what is the exact command to resume each one?

**Q3** Which steps, in order, must the Owner take before M3 (an off-LAN wake from a phone on 5G) can become PASS, and where is the ordered procedure written?

**Q4** For phases 17, 18, 19 and 20, what is proven (with the label that says how it was proven) and what is still owed?

**Q5** Why does `can-wake-remote` never read `supported`, and how does a phone learn that a broker accepts remote wake requests?

**Q6** What is the M4 verdict, what does `can-power-on-oob` read on this laptop, what is its wire reason, and what is its verification label?

**Q7** Which milestone actions must not run now, and why?

**Q8** What is the next action for an agent, and what is the next action for the Owner?

## Rubric

Pass rule: every required fact is stated, and every citation resolves to a line that contains the fact. Any missed
fact or failed citation is a gap; fix it in `.planning/STATE.md` with a scoped edit. Line numbers were resolved after
the 20-05 STATE.md edits; the orchestrator re-resolves any that moved before scoring.

| Q | Required facts | Where each lives |
|---|---|---|
| Q1 | Worktree `C:\owx-haf`; branch `mobile/host-availability`; HEAD local, never pushed; at least five of: never push or merge (Owner-only); do not touch the primary checkout, `C:\ox` or other worktrees; fresh output proves a live-control claim, history does not; UNKNOWN is never zero or offline and a negative needs a positive control; no second remote-control transport; git through PowerShell; laptop 8 GB, single vitest files, heavy runs on GEX44 | `.planning/STATE.md:61`, `.planning/STATE.md:139-147`, `.planning/STATE.md:62` |
| Q2 | All four are `verification_deferred_human` (human_needed); resume `/gsd-verify-work 17`, `/gsd-verify-work 18`, `/gsd-verify-work 19`, `/gsd-verify-work 20` | `.planning/STATE.md:91` (17), `.planning/STATE.md:89` (18), `.planning/STATE.md:90` (19), `.planning/STATE.md:92` (20), `.planning/STATE.md:63`, `.planning/phases/20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4/20-VERIFICATION.md:3` |
| Q3 | In order: BIOS step (b) Resume by PCI-E / LAN on and ErP off; step (c) an always-on LAN node running `orca serve --wake-broker`; cloud auth for the relay on that node (`cloud_auth_not_configured` today); then the procedure: confirm `can-relay` supported and `host.wake-broker.v1`, `orca wake target add` and `orca wake grant add`, pair the phone, sleep the PC, send from a phone on 5G with Wi-Fi off, observe packet-sent then host-announced, runtime-ready and fresh terminal output, confirm no inbound port. The procedure is in 20-VERIFICATION.md section M3 | `.planning/STATE.md:48-52`, `.planning/phases/20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4/20-VERIFICATION.md:85-107`, `.planning/phases/19-wake-on-lan-capability-and-the-lan-wake-broker-m2/19-VERIFICATION.md:123` |
| Q4 | 17: SC1, SC2a, SC2b, SC3a PASS on a disposable serve host (SCRIPTED CLIENT); owed the Task Scheduler leg and rows O1-O6 on the Owner's PC. 18: model, producer, card and claims gate PASS with 5 mutants; owed the card on a real phone or labelled emulator and a live status.get read. 19: SC1 MEASURED unknown/firmware_unverified, SC2 PASS (SCRIPTED CLIENT live + UNIT in-process); owed LAN Product Reality OWNER_BOUND (steps b, c). 20: SC1 transport independence UNIT in-process relay (live M3 OWNER_BOUND), SC2 PASS with can-power-on-oob MEASURED, SC3 rows K/L/M, twelve mutants, G6; owed M3 OWNER_BOUND, M4 HARDWARE_BOUND, WOL from S5 OWNER_BOUND, mobile Wake control DEFERRED | `.planning/STATE.md:89-92`, `.planning/phases/20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4/20-VERIFICATION.md:38-40` |
| Q5 | Option B (D-04): `can-wake-remote` is `not-configured / no_wake_broker` on every host from one producer, `describeRemoteWakeCapability`; a broker serves wake targets and is not one, and a target cannot know from its own configuration that a broker will wake it. A phone learns acceptance from the broker's `host.wake-broker.v1` capability plus a current `host.wake.targets` answer | `docs/reference/host-wake-broker.md:73-77`, `.planning/phases/20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4/20-VERIFICATION.md:125` |
| Q6 | M4 HARDWARE_BOUND (AMD, no AMT); `can-power-on-oob` reads `not-supported` with evidence `os-probe`; wire reason `hardware_bound_amd_no_amt`; verification label `HARDWARE_BOUND` (an uppercase wire reason would parse to `unspecified`); measured AuthenticAMD, MEI 0; WOL from S5 with Fast Startup off OWNER_BOUND, never assumed | `.planning/phases/20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4/20-VERIFICATION.md:111-119`, `.planning/phases/20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4/20-oob-probe-evidence.json:4`, `.planning/phases/20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4/20-oob-probe-evidence.json:10` |
| Q7 | Milestone audit, complete and cleanup must not run while any phase is human_needed (5, 7, 9, 17, 18, 19, 20): completing would archive unverified legs as done | `.planning/STATE.md:66`, `.planning/STATE.md:133`, `.planning/phases/20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4/20-VERIFICATION.md:193` |
| Q8 | Agent: append the orchestrator's fresh-agent result to 20-VERIFICATION.md if not yet there; otherwise no autonomous phase 20 work remains (M3 waits on the Owner, M4 HARDWARE_BOUND; new work needs a new plan). Owner: step 1, the BIOS step (b), then the ordered list | `.planning/STATE.md:65`, `.planning/STATE.md:48`, `AGENTS.md:127` (the Host Wake law it must respect) |

## Orchestrator run

After the 20-05 commits (not a task and not a checkpoint of the plan):
1. Dispatch ONE read-only agent (Read, Grep, Glob only; no chat context). Give it the Questions section above
   verbatim and the instruction: answer from durable files under `C:\owx-haf` only, with `file:line` citations for
   every fact.
2. Score the answers with the Rubric section: N/N questions, and list every citation that failed to resolve.
3. Fix every gap in `.planning/STATE.md` with scoped edits.
4. Append `## Fresh-agent test (orchestrator)` to `20-VERIFICATION.md` with N/N, the citations that failed and the gaps
   fixed.
5. Commit `docs(20): fresh-agent test`.
