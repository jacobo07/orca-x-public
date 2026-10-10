# Phase 20 verification: environment contract and prepare this device

Status: PASSED for the unit-test scope; live legs judged from recorded evidence, not re-run (2026-10-10).
Head verified: 466b62d82 (+ U11 canary merges, 45a649fea). Supersedes the interrupted 2026-10-02 stub (status: incomplete).

Goal: "Reproduce requirements, not machines."

## Truths

| # | Truth | Verdict | Basis |
|---|-------|---------|-------|
| SC1 | orca.yaml requirements are measured on local, SSH and runtime hosts (row 68) | PASS | Re-run: shared probe core, state, requirements parser and CLI/presentation tests green (below). Live: Run 7 L1 (seven states as seeded over real ssh2, git 2.43.0 equal to independent read, contract sha equal to seed), runtime-host leg R1, old-relay leg O1 (docs/dws/phase-20-environment-contract-evidence.md). Not re-run here. |
| SC2a | Prepare plan shows six states | PASS | environment-prepare-plan, environment-requirement-state tests; Run 7 L1. |
| SC2b | Only authorized actions run | PASS | authority, device-gate and step-runner tests re-run green; Run 7 L3 (stale approval refused contract-changed, shim absent), L4 (approval for another host refused, shim absent), L2 (approved step ran). |
| SC2c | No secrets | PASS | Run 7 L5 absence scan: control found, 0 hits, scanned after app exit. |
| Gap | MR-1 approved bytes are the bytes that run | PASS | step-runner test (rawCommand literal bytes) re-run green. |
| Gap | MR-2 lost/late answer is "unknown", not "Not started"; LR-1 unknown refusal reason validated | PASS | runtime-environment-requirements-client and presentation tests re-run green. |
| Gap | MR-3 hidden characters labelled and escaped in the dialog and CLI; hash unchanged | PASS | plan, hash KAT, dialog, CLI tests re-run green. |
| Gap | LR-2 failed approval write is logged | PASS | PrepareStepApprovalDialog test re-run green. |
| L6 | Dead SSH transport reads unreachable, not contract-unreadable | PASS (recorded) | b6411fa6f; Run 7 L6 rows=1 reasons=unreachable, missing=0. |

## Re-run (this unit)

13 files, 211 tests, 0 failed (vitest, scoped list in the X07 record proof.cmd).
The 20-05g run recorded one unrelated failure (OrchestrationSkillAgentCoverage); that file is outside this set and was not re-run.

## Not observed / residual

- WSL: NOT_RUN (no distro on the evidence host).
- Runtime-host prepare, local prepare and folder-workspace prepare are LOCAL-HOST units only (no live runtime-host prepare step).
- Live two-host legs were not re-run on 2026-10-10 (no second host in this unit); verdicts rely on the 2026-10-02 evidence.
- MR-3 is label + display only (no parse-time refusal). The host-side runtime still records no grant (pre-existing debt).
- Row 68's reason text still says the L6 defect is "carried to row 69" (stale).
