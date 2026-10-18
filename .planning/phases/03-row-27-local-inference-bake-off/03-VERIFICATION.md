---
phase: 03-row-27-local-inference-bake-off
verified: 2026-10-18T15:40:00Z
status: passed
score: 4/4 must-haves verified
covered_files:
  - .planning/phases/03-row-27-local-inference-bake-off/03-01-PLAN.md
  - .planning/phases/03-row-27-local-inference-bake-off/03-01-SUMMARY.md
  - config/dws-completion-matrix.jsonc
  - config/scripts/dws-inference-bakeoff.py
  - docs/dws/bk-bakeoff.json
  - docs/dws/bk-measure.json
  - docs/dws/live-2026-10-18-row-27-local-inference-bakeoff.md
covered_digest: "v1:sha256:46d39f2a5c59e2f52955efb13a9bcb315842c04768ec6a6a950ce8d7e1140175"
behavior_unverified: 0
---
# Phase 3 Verification

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | Re-measure: model id from server, resident, tok/s and first-token over N>=5 | VERIFIED | bk-measure.json: qwen3-coder-30b, n=5, 48.88 tok/s median, first-token 0.028 s (cache-warm lower bound; cold 1.5 s) |
| 2 | >=10 committed tasks, same prompts and scorer both sides | VERIFIED | 12 tasks in dws-inference-bakeoff.py; bk-bakeoff.json has local and claude rows |
| 3 | JSON + doc with latency/throughput/pass rate; scorer can fail | VERIFIED | doc table; control mode: wrong_answers_passed=[] over 12 |
| 4 | Row 27 restated | VERIFIED | matrix row 27 PASS at fb16c4f39b; checker 35/76, vitest 30/30 |

## Not covered
The set is at the ceiling for both sides (does not rank them); Claude ran as kobii; Claude latency includes process startup.
