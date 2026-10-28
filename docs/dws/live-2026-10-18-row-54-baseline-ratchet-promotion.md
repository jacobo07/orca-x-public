# Row 54 — standards promoted through the Constitutive Baseline Ratchet (2026-10-18)

The ratchet lives in the claude-power-pack worktree `C:\Users\User\Apps\pp-dws-rows-wt`, branch `dws/pp-rows`. PP commit `52c7ab29` is LOCAL and not pushed; pushing is Owner-gated.

## What was promoted

`modules.tower.ratchet.promote("multi_host_fabric", …)` (run by `tools/promote_multi_host_fabric_b1.py`) wrote `vault/tower/baselines/multi_host_fabric/B1.json` on top of the phase-5 B0 (6 entries). B1 adds two standards from the row 59 and row 70 live runs, each with a cited origin line and a runnable check against this repo:

| Entry | Origin line (this repo) | Check |
|---|---|---|
| `multi_host_fabric-live-leg-never-answers-bypass-consent` | `docs/dws/live-2026-10-18-row-59-model-turn-evidence.md:29` | regex `HWF59M_ARGV_BYPASS_FLAG=absent` in that doc |
| `multi_host_fabric-transfer-is-read-back-on-the-target` | `docs/dws/live-2026-10-18-row-70-resume-evidence.md:20` | regex `XFER_BYTES=[1-9]` in `tests/e2e/hwf-two-host-continue-here-resume.spec.ts` |

The service-home standard from phase 6 was already a B0 entry (phase 5). The Ink `CSI C` trap was NOT promoted: its fix lives in the live-leg harness under `C:\Users\User\Apps\rbl`, outside this repo, so no check here can witness it.

## Read back and tests

`python tools/test_tower_mhf_promotion.py` → `MHFP_PASS=9/9`:

- B1 read from disk: 8 entries, both ids present, `promoted_by` and a `promote …` reason recorded.
- `verify_chain` B0→B1: anchored, no regression, every origin quote on its cited line.
- `donegate.judge` on this repo: `multi_host_fabric/B1`, 8/8 APPLIED_VERIFIED.
- Refusals on a copy of the baselines: a revert with no reason raises `RatchetRefusal`; re-promoting an existing id raises `RatchetRefusal`; a raw B2 that drops the transfer check to prose with no record reads `WEAKENED` on the chain. The real chain stays clean beside it (control).

Existing ratchet suites after the promotion: `test_tower_ratchet` 22/22, `test_tower_multi_host_fabric` 12/12 (expectations moved from B0 to B1), `test_family_baselines` 22/22, `test_family_injection` 26/26, `test_baseline_inheritance` 31/31, `test_tower_donegate` 12/12, `test_tower_inheritance` 16/16.

## Not covered

The wiki component page `wiki/components/constitutive-baseline-ratchet.md` was not changed. The PP commits `8b776241`, `18bc67aa`, `a1f5f45b`, `52c7ab29` are local only.
