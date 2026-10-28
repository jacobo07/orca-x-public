# Phase 1: Reality close and RED - Context

**Gathered:** 2026-10-26
**Status:** Ready for planning
**Mode:** Autonomous smart-discuss (unattended; recommended option taken on every grey area)

<domain>
## Phase Boundary
Write down the ownership graph for phone control of a live session and land a RED test that fails
for the real missing proof (no fresh-output oracle). No product behaviour changes in this phase.
</domain>

<decisions>
## Implementation Decisions
- D-01 RED test level: a vitest unit test in `src/shared/` against the real `RuntimeTerminalRead`
  shape, not an e2e. Why: the laptop cannot build the app (STATE laws); the headless paired harness
  needs a build. Phase 2 makes it GREEN and Phase 7 wires it to the live leg.
- D-02 Oracle contract (what Phase 2 must implement): `judgeFreshTerminalOutput({handle, marker,
  nonce, before, after})` returns FRESH only when the nonce appears after the marker in the post-send
  read of the same handle; a nonce already present before the send is CONTAMINATED; a truncated read
  or a missing pre-send cursor is UNKNOWN, never FRESH.
- D-03 Owner list is grep-backed and lives in 01-OWNERS.md with the commands that produced it.
</decisions>

<deferred>
## Deferred Ideas
- Wiring the oracle into the headless paired e2e (Phase 2 / Phase 7).
</deferred>
