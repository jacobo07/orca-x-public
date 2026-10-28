# Phase 18: Availability state, capabilities and a truthful host card - Context

**Gathered:** 2026-10-27
**Status:** Ready for planning
**Mode:** Smart discuss, autonomous (Owner re-ran `/gsd-autonomous --from 17`; phase 17 is deferred human
verification). Grey areas resolved from the Owner-approved brief (`.planning/HOST-AVAILABILITY-PLAN.md`
decisions 3, 4, 8); where the brief is silent the recommendation was taken and is marked (rec).

<domain>
## Phase Boundary

The phone says what Orca knows about a host, what the host can do, and what Orca cannot know. In scope: a
shared availability model with three composed dimensions, a capability set kept apart from state and from
grants, an additive host producer (status RPC), a mobile host-card projection, and a gate with mutants.
Out of scope: any wake or power-on effect (19, 20), grants `REMOTE_*` issuance (19), Node Manifest edits in
`C:\ox` (proposal only).

</domain>

<decisions>
## Implementation Decisions

### Model (brief decision 3)
- D-01: One shared module (e.g. `src/shared/host-availability.ts`) defines three separate fields, never one enum:
  - power: `awake | sleeping | hibernating | powered-off | unknown | unobservable`
  - orca: `service-ready | runtime-ready | ui-open | ui-closed | starting | version-mismatch | unavailable | unknown`
  - connectivity: the existing `ConnectionVerdict` kinds plus `wake-proxy-available | oob-available`
  A pure `composeHostAvailability(observations)` derives them, and every non-unknown value carries the evidence
  kind that produced it (e.g. `live-response`, `host-announced`, `relay-reported`) and an observed-at time.
- D-02: No response is `unknown`, never `powered-off` and never `offline`. In this phase no producer can emit
  `sleeping`, `hibernating` or `powered-off` (no evidence source exists yet); the type allows them for 19/20.
  `awake` only from a live response in this session.
- D-03 (rec): orca derives from what the host already reports: runtime status (`runtime.getStatus()`), the
  desktop window status (`RuntimeDesktopWindowStatus`: available -> ui-open, openable/initializing/blocked ->
  ui-closed with that sub-reason), protocol compatibility -> version-mismatch.

### Capabilities (brief decision 4)
- D-04: Capabilities `can-start-orca`, `can-wake-lan`, `can-wake-remote`, `can-power-on-oob`, `can-relay`,
  `can-direct`, each with a value `supported | not-supported | not-configured | needs-owner-setup | unknown`
  and a reason. They are separate from state and from grants (`DeviceScope` stays as is).
- D-05 (rec): The host reports them additively in `status.get` behind a new runtime capability string (e.g.
  `host.availability.v1`); old hosts answer without it and the phone renders unknown. Values today:
  `can-relay` from the phase 17 relay readiness, `can-direct` from the bound endpoint, `can-wake-lan` and
  `can-wake-remote` `not-configured` (no broker yet), `can-power-on-oob` `not-supported` with reason
  HARDWARE_BOUND only where measured, else `unknown`; `can-start-orca` from the phase 17 autostart status
  (`unknown` when unreadable).
- D-06: Node Manifest (`C:\ox\src\shared\node-manifest.ts`) is owned by the DWS lane: write an additive
  field proposal artifact in this phase dir; never edit `C:\ox`.
- D-07: Remote wire compatibility per `docs/reference/remote-wire-compatibility.md`: optional fields only, no
  new stream opcode.

### Mobile card (brief decision 8)
- D-08: `MobileHostCard` renders a projection from a pure presenter (one place maps availability to label and
  tone). It never renders `powered-off` without evidence, and never renders Wake/Power-on in this phase (no
  backend effect exists). Unknown is stated as unknown.
- D-09 (rec): Copy stays in the card's current English literal style (the mobile card has no i18n layer
  today); the brief's "use existing i18n" maps to "no new mechanism".

### Gate (brief decision 8)
- D-10: A presentation-table gate in the style of `check:workspace-surface-claims` (`config/*.jsonc` table +
  `config/scripts/check-*.mjs` + test): every label/action the card can render maps to a producer and an
  evidence kind; `powered-off` without evidence and any action without a backend RPC method fail the gate.
  Two mutants (powered-off without evidence, Wake button without effect) are PLANT_CONFIRMED, CAUGHT,
  RESTORE_VERIFIED.

### Proof and laws
- D-11: Mobile tests need `mobile/node_modules`, not installed on this laptop: run them on GEX44 in a
  disposable root (STATE.md recipe, plus `pnpm rebuild node-pty` only if a build is needed). Node-side tests
  run here, single files.
- D-12: Never push. No Owner-PC effects in this phase.

### Claude's Discretion
File names, the evidence-kind vocabulary, presenter shape, exact wording.

</decisions>

<code_context>
## Existing Code Insights

- `mobile/src/transport/connection-health.ts:31-100` (`ConnectionVerdict`, `classifyConnection`).
- `mobile/src/components/MobileHostCard.tsx` (+ `.test.ts`, `.test.tsx`), `StatusDot`.
- `src/main/runtime/rpc/methods/status.ts` (`status.get` spreads `runtime.getStatus()` + appVersion).
- `src/shared/protocol-version.ts:150-203` (`RUNTIME_CAPABILITIES`, `RuntimeCapability`).
- `src/shared/runtime-types.ts:47` (`RuntimeDesktopWindowStatus`), `:55` (`DeviceScope`).
- Gate template: `config/workspace-surface-claims.jsonc`, `config/scripts/check-workspace-surface-claims.mjs`
  (+ `.test.mjs`); surfaces already include `mobile/src/workspace`.
- Phase 17 producers: `src/main/runtime/relay/host-relay-startup.ts` (relay readiness),
  `src/cli/runtime/serve-autostart.ts` (task status).

</code_context>

<specifics>
## Specific Ideas

Laws: unreachable is not powered off; a host awake is not a runtime ready; no button without a backend effect.

</specifics>

<deferred>
## Deferred Ideas

- Host pre-suspend announcement as evidence for `sleeping` (phase 19).
- Wake / Power-on actions and `REMOTE_*` grants (19, 20).

</deferred>
