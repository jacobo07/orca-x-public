# Phase 7: Real laptop Product Reality - Context

**Gathered:** 2026-10-26
**Status:** Ready for planning
**Mode:** Autonomous smart-discuss (unattended; recommended option taken)

<domain>
## Phase Boundary
The real Windows app hosts the PTY and a paired phone (physical if available, else labelled emulator)
drives it end to end: nonce, fresh output, reconnect, revocation, wrong host.
</domain>

<decisions>
## Implementation Decisions
- D-01 Build the leg that can run without the Owner first: `tests/e2e/headless-paired-mobile-terminal-fresh-output.spec.ts`
  launches the built app with `--serve` in an isolated profile and drives it with
  `tests/e2e/helpers/mobile-protocol-client.ts`, which speaks the phone's E2EE handshake and encrypted
  JSON-RPC. The same spec is the one the Owner runs on Windows.
- D-02 Labels: this is the built app headless on Linux (GEX44, xvfb) with a scripted protocol client.
  It is not the Owner's desktop app, not Windows, not a phone, not an emulator.
- D-03 Revocation is not driven here: revoke is renderer IPC (`mobile:revokeDevice`) and the headless
  host has no renderer. Phase 3 proved it on the real RPC server and socket.
- D-04 OWNER DECISION NEEDED (not acted on): pairing any client to the Owner's live Windows install
  adds an authorized remote device to that machine. See STATE.
</decisions>
