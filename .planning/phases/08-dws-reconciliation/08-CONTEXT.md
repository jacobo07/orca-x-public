# Phase 8: DWS reconciliation - Context

**Gathered:** 2026-10-26
**Status:** Ready for planning
**Mode:** Autonomous smart-discuss (unattended; recommended option taken)

<domain>
## Phase Boundary
DWS extends the mobile owner: stale desktop and stale mobile writes are refused and the current
controller is accepted (Orca half of rows 33/39); a relay zero is reported only with a positive
control (X18/row 74); X16 placement reaches dispatch; a verdict on X05, X06, X16, X18, X19.
</domain>

<decisions>
## Implementation Decisions
- D-01 Controller = the runtime's per-PTY driver (`getDriver`); a mobile send with a client id takes
  the floor via `beginMobileInputFloor` (requires a mobile subscriber); `isTerminalInputLockedForClient`
  refuses a desktop write while the driver is mobile. Proven in the Phase 2 scope test (extended).
- D-02 Row 74 instrument is already the right one: `relay-sent-method-tally.ts`, called at the
  multiplexer write (ssh-channel-multiplexer.ts:415), off unless ORCA_E2E_RELAY_METHOD_TALLY=1; the
  live spec requires `logs===1` and `methods>0` before accepting a sync/fabric zero.
- D-03 X16's "dispatch not wired" receipt is stale: `missionPlace` goes through
  mission-dispatch-placement.ts and worker start enforces `assertWorkerStartMatchesPlacement`
  (commits e55352858 .. bf6742acc).
- D-04 The DWS matrix is not edited: rows 33 and 39 remain blocked on UWCP (another program); a GSD
  unit done is not a DWS row PASS (STATE law).
- D-05 X unit sources were read read-only from GEX44 ~/missions/dws-exec/ctl (receipts, records).
</decisions>
