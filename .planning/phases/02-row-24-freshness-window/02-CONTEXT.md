# Phase 2: Row 24 freshness window - Context

**Gathered:** 2026-10-18
**Status:** Ready for planning
**Mode:** Auto-resolved from ROADMAP success criteria + Owner decisions 2026-10-18 (background run, no interactive prompts)

<domain>
## Phase Boundary

Placement treats a host's ready project setup as hydrated only when its `updatedAt` is within 7 days of the placement clock; older ready setups rank as unhydrated (never ineligible). Unit tests red first, a mutant, tsc + oxlint + oxfmt, then the live r24 leg rerun with one stale and one fresh setup, and row 24 restated in `config/dws-completion-matrix.jsonc`.

</domain>

<decisions>
## Implementation Decisions

### Window and clock
- One exported constant `HYDRATED_SETUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000` in `src/shared/mission-job-locality.ts` (Owner: 7 days).
- `hydratedAddressesForProject(projectId, setups, now)` takes the clock as a required parameter; no `Date.now()` inside. The only production caller (`orchestration-mission.ts:104`) passes `observation.completedAt`, the same clock the fleet-sample freshness already uses.
- Age is `now - updatedAt`; fresh when `age <= window` (exactly 7 days is still fresh).

### Stale / malformed semantics
- Stale ready setup = unhydrated (omitted from the hydrated list). It is never ineligible: ranking in `placement-host-ranking.ts` is untouched, so the host still places, just after hydrated ones.
- Missing or non-finite `updatedAt` = unhydrated (fail to the cautious side, no fabricated freshness).
- A future `updatedAt` (clock skew, negative age) counts as fresh; only measured staleness demotes.

### Types
- `ProjectSetupClaim` gains `updatedAt`; the stale comment "updatedAt is deliberately not read" and the test pinning the old key set are replaced, not deleted silently.

### Claude's Discretion
- Test layout and helper naming, within the existing `mission-job-locality.test.ts` style.
- Live-leg driver details: reuse the r24 leg (`r24h`, `r24r`) and `C:\Users\User\Apps\rbl\` drivers.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/shared/mission-job-locality.ts` `hydratedAddressesForProject` (the one seam); `src/shared/placement-host-ranking.ts` `rankMissionCandidates` consumes `isHydrated` and needs no change.
- `src/shared/mission-job-locality.test.ts` currently asserts updatedAt is NOT read (5th test) and that the type has no time key (6th); both invert.

### Established Patterns
- Clock injected as `now` (see `planDispatchableMission(..., { now: observation.completedAt, maxSampleAgeMs })`).

### Integration Points
- `src/main/runtime/rpc/methods/orchestration-mission.ts:99-107` builds `hydratedAddresses`; `runtime.listProjectHostSetups()` returns full `ProjectHostSetup` including `updatedAt`.

</code_context>

<specifics>
## Specific Ideas

No specific requirements beyond the ROADMAP criteria.

</specifics>

<deferred>
## Deferred Ideas

None.

</deferred>
