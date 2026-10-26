# Phase 2: Scoped terminal input and fresh-output oracle - Context

**Gathered:** 2026-10-26
**Status:** Ready for planning
**Mode:** Autonomous smart-discuss (unattended; recommended option taken)

<domain>
## Phase Boundary
A mobile `terminal.send` reaches exactly one PTY, and that is proven by output the send caused.
Covers the oracle (GREEN for the Phase 1 RED) and the scope legs: newest terminal, wrong host
(runtime), stale generation. Device and live-laptop legs belong to Phase 7.
</domain>

<decisions>
## Implementation Decisions
- D-01 Oracle accepts only an exact output line `MARKER NONCE`; the command is sent as
  `echo MARKER' 'NONCE` so its echo never matches. Sent text containing the joined line is UNKNOWN.
  Why: an oracle keyed on "nonce after marker" accepts the shell's echo of the typed command.
- D-02 Host scope is the per-host connection plus the runtime's own handle map: a handle minted by
  another runtime is unknown here and refused `terminal_handle_stale`. No host field is added to the
  wire (remote-wire-compatibility: nothing new to negotiate). Runtime scope = `record.runtimeId`.
- D-03 Generation scope already exists (`ptyGeneration`, `rendererGraphEpoch` in
  `getLiveLeafForHandle`); this phase proves it on the mobile send path instead of re-implementing it.
- D-04 Proof plane: a real `OrcaRuntimeService` behind the real `TERMINAL_METHODS` dispatcher with a
  fake PTY controller that executes `echo`. Labelled unit/integration, not live.
</decisions>

<deferred>
## Deferred Ideas
- Paired-client e2e against the headless runtime host (needs a build; GEX44 or Phase 7).
</deferred>
