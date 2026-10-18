---
status: human_needed
phase: 02
verified: 2026-10-18T15:35:00Z
covered_files:
  - .planning/phases/02-row-24-freshness-window/02-01-PLAN.md
  - .planning/phases/02-row-24-freshness-window/02-01-SUMMARY.md
  - config/dws-completion-matrix.jsonc
  - src/main/runtime/rpc/methods/orchestration-mission.ts
  - src/shared/mission-job-locality.test.ts
  - src/shared/mission-job-locality.ts
covered_digest: "v1:sha256:4a681a6fd02198e9c0ba9f78db8a4ed0f1a892e54f08e6406d7d59f1adbfe378"
behavior_unverified: 1
---
# 02 Verification

- PASS (unit): window, boundary, missing/NaN/Infinity, future time, injected clock; mutant red.
- NOT_RUN (live): stale->GEX44 / fresh->local in persisted task_placements. Command: C:\Users\User\Apps\rbl\run-leg.ps1 -Row 24 -Tag r24f -Specs tests/e2e/hwf-two-host-mission-locality.spec.ts -Driver p24 -Markers "HWF24_HYDRATED_PREFERRED,HWF24_REMOTE_PREPARED_PREFERRED,HWF24_FRESHNESS_WINDOW"
- Row 24 is not stamped PASS.
