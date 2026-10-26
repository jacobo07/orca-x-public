# Phase 3: Reconnect and revocation - Context

**Gathered:** 2026-10-26
**Status:** Ready for planning
**Mode:** Autonomous smart-discuss (unattended; recommended option taken)

<domain>
## Phase Boundary
A phone that disconnects and reconnects keeps the same terminal identity and the PTY survives; a
revoked phone whose socket survived is refused at its next terminal mutation with a distinct reason.
</domain>

<decisions>
## Implementation Decisions
- D-01 Reuse the existing effect-time authority (`assertDeviceStillAuthorized`, device-authorization.ts)
  and the real `OrcaRuntimeRpcServer` + encrypted mobile WebSocket harness. No second check is added
  (effect-authority rule: one effect, one authority).
- D-02 "Session id" = the terminal handle plus its ptyId as listed to the phone; "PTY count did not
  grow" = one spawn and no kill across the disconnect.
- D-03 "Distinct code" = wire code stays `unauthorized` (old clients fail closed on it) and the reason
  `device_revoked` rides in `error.data`, distinct from `unknown_token`.
- D-04 Reconnect = re-authenticating with the same pairing URL (same device token) on a new socket.
</decisions>
