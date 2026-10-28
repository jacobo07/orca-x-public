# Row 55 (Inheritance verification) -- planted regression goes red, 2026-10-18

Row 55's `done` is "planted regression red". The inheritance channel is the Power Pack tower: this repo
inherits the `multi_host_fabric` family, whose newest generation B1 (row 54) carries 8 standards with
runnable checks, and `modules.tower.donegate.judge` judges this repo against them.

## The drill
Claude Power Pack `dws/pp-rows` d653fd44 (pushed): `tools/test_tower_mhf_inheritance_drill.py`.

- Subject: a copy of exactly the 6 files B1's checks read (derived from the checks themselves, so a new
  entry is covered without editing the test), taken from this repo.
- Control: the real repo is `multi_host_fabric/B1`, 8/8 APPLIED_VERIFIED; the clean copy is judged the same.
- Plant 1: `tests/e2e/hwf-two-host-continue-here-resume.spec.ts` stops reading the transfer back on the
  target (`XFER_BYTES=` renamed). Only `multi_host_fabric-transfer-is-read-back-on-the-target` turns
  VIOLATED; `would_block` true.
- Plant 2: `src/main/workspace-execution-consent.ts` deleted. Only
  `multi_host_fabric-consent-refusal-is-not-failure` turns VIOLATED; `would_block` true.
- Every finding is stamped `multi_host_fabric/B1`.
- Result: MHFI 6/6. Instrument check: with the judge mutated to map a failed check to APPLIED_VERIFIED,
  both plant gates go red (4/6); the judge was restored byte-exact.

## Also caught for real, not planted
The mobile capability aperture gate was red at HEAD on 2026-10-18 (8 methods without a disposition);
classified and baselined in a433269911, with a dropped-entry control that turns it red.

## Not covered
The done-gate is report-only by design (`report_only: true`): it states what enforcement would have done
and blocks nothing. Wiring it as a blocking CI step is an Owner decision the PP spec keeps separate.
