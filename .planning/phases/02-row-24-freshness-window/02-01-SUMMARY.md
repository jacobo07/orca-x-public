# 02-01 Summary

Status: unit-complete, live leg NOT_RUN.

- 5e9d4d3451: HYDRATED_SETUP_MAX_AGE_MS = 7 days; hydratedAddressesForProject(projectId, setups, now); caller passes observation.completedAt. 83/83 placement tests, mutant red (3 tests), tsc/oxlint/oxfmt clean.
- 8fdda890e4: e2e leg (profileOverlay fixture + stale/fresh projects) and matrix row 24 restated. Row stays PARTIAL.
- NOT_RUN: live r24f leg. Runner refused WAIT_RESOURCE, free RAM 4.88 then 3.92 then 4.18 GB, floor 6 GB. Memory is held by other sessions; none were killed.
