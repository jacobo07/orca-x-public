# Phase 21: Mobile Wake control on the host card - Context

**Gathered:** 2026-10-28
**Status:** Ready for planning
**Mode:** Smart discuss, autonomous. Added after the Owner said "keep going" once phases 17-20 were built and every
remaining leg was Owner- or hardware-bound. This phase closes the 19 D-13 deferral. Its four reasons are in
`19-VERIFICATION.md:140-148`, and each one is answered below. Recommended options are marked (rec).

<domain>
## Phase Boundary

A paired phone can ask a LAN Wake Broker to wake a sleeping host from that host's own card. The card shows the
wake's evidence stages truthfully.

In scope:
- an additive binding of a broker target to a host identity;
- phone-side routing from a target card to the broker that answered this session;
- the Wake control and its stage presenter;
- the claims gate scoped per control, with mutants;
- mobile tests on a GEX44 disposable root.

Out of scope:
- off-LAN live legs (OWNER_BOUND, phase 20);
- broker discovery and auto-registration;
- any change to who may wake (grants stay as in 19);
- real-device verification (owed, human_needed).

</domain>

<decisions>
## Implementation Decisions

### Cross-host routing (D-13 reason 1; SC1)
- D-01: A broker target may carry an optional binding to the target host's identity. The Owner sets it on the
  broker through the local CLI (e.g. `orca wake target add ... --host <id>`, or a `target bind` verb).
  - It uses an identity the target host itself publishes, and that the phone has already observed from that host
    over its own pairing. Research picks the field: e.g. the runtime/host id that `status.get` or pairing exposes.
  - Mapping by label, name or IP is forbidden. No binding means no control.
- D-02: `host.wake.targets` returns the binding as an optional additive field, per
  `docs/reference/remote-wire-compatibility.md`. An old broker without it yields no control. The MAC still never
  leaves the broker.
- D-03: The phone keeps broker answers per session only. They come from the 20-03 composer (`host-wake-proxy.ts`,
  `planWakeRequest`), extended to look up the binding for a given host. That composer is the only authority on
  whether the control renders and where the request goes. Nothing persisted counts as evidence (rec: no
  persistence at all).
- D-04: When two brokers bind the same host, the phone prefers neither (rec: no control; the state is
  "ambiguous broker"). Guessing which broker to use is refused. An alternative is the most recently answered
  broker; rejected because it is a guess.

### Control and stages (D-13 reason 2; SC2)
- D-05: One Pressable with literal `testID="host-card-wake"`, classified in `config/host-card-claims.jsonc` with
  effect rpc `host.wake.request`. Each press mints a fresh requestId, and the broker's dedupe handles retries.
  There is no confirm dialog (rec): a wake is idempotent and reversible by the machine sleeping again.
- D-06: A pure presenter maps wake stages and refusal codes to labels, using a new `wake.*` label family:
  - `requested`, `authorized`, `packet-sent`, `packet-send-failed`, each refusal code, and `unknown`;
  - `host-announced` and `runtime-ready` only from the target host's own answer on its own connection after the
    request. The broker never produces them.
  "Woken" or "On" never renders from a broker stage. Copy stays English literals in the card's style (18 D-09).
  Tokens come from `mobile-theme.ts` and the STYLEGUIDE.
- D-07: Progress is read through `host.wake.status` while the card is visible and the wake is not terminal. Any
  poll is bounded and stops when the card is hidden or the wake ends; it is classified in
  `config/recurring-work-inventory.jsonc` if it lives under `src/`, or kept event-driven if the mobile code has a
  lifecycle hook (rec: re-read on focus or press, no free-running timer).

### Claims gate (D-13 reason 3; SC3)
- D-08: `check-host-card-claims.mjs` scopes its effect-wording check per control. The first effect control must not
  disable the check card-wide (`check-host-card-claims.mjs:427-436` per 19-RESEARCH).
  - The new `wake.*` labels are classified with their producers and evidence.
  - `wake.host-announced` requires target-host evidence.
- D-09: Mutants, each PLANT_CONFIRMED / CAUGHT / RESTORE_VERIFIED:
  - effect wording on another control is no longer checked;
  - the Wake control is classified with a non-existent rpc;
  - "Woken" is rendered from `packet-sent`;
  - the control renders without a broker binding.

### Proof and laws (D-13 reason 4)
- D-10: Mobile tests and any mobile typecheck run on a GEX44 disposable root, reusing the 18-02 runner
  (`18-gex44-mobile-vitest.ps1/.sh`), with teardown proof. Node-side tests run as single files here.
- D-11: The phone leg (a real phone or labelled emulator presses Wake on a sleeping host) is owed: human_needed,
  and also OWNER_BOUND on 19/20 steps b and c. A SCRIPTED CLIENT may drive the RPC path. The UI is proven by unit
  and render tests only.
- D-12: Never push. No Owner-PC effects. Work only in C:\owx-haf, never the primary checkout.

### Claude's Discretion
- Field names for the binding.
- The CLI verb shape.
- Presenter file names and exact copy.
- The ambiguous-broker label wording.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/shared/host-wake-proxy.ts` (20-03): composes from this session's answers only; `planWakeRequest`.
- `src/main/runtime/rpc/methods/host-wake.ts`: `host.wake.targets`, `host.wake.request`, `host.wake.status`.
- `rpc/methods/host-wake-admin.ts` with the `orca wake` CLI (`src/cli/handlers/wake.ts`, `specs/wake.ts`).
- `wake-broker-store.ts` and `wake-broker-state-schema.ts`: the target shape and its durability contract.
- `mobile/src/components/MobileHostCard.tsx` with the phase 18 presenter (`host-availability-presentation.ts`,
  `HOST_CARD_LABELS`).
- `config/host-card-claims.jsonc` and `config/scripts/check-host-card-claims.mjs`, plus G6
  (`host-capability-producer-gate.mjs`).
- The GEX44 mobile runner `18-gex44-mobile-vitest.ps1/.sh`.

### Established Patterns
- Additive optional wire fields.
- Presenter tables plus a gate.
- Mutant drills with byte restore.
- Single-file vitest on the laptop; mobile on GEX44.

### Integration Points
- The mobile host list and card.
- The mobile RPC client per host connection.
- Broker store schema (a schema bump needs the 19 newer-schema rule).

</code_context>

<specifics>
## Specific Ideas

Laws: a wake packet sent is not a host woken; no button without a backend effect; unknown stays unknown; never guess
which broker or which target.

</specifics>

<deferred>
## Deferred Ideas

- Broker discovery and target auto-registration (the target announcing itself to a broker).
- A desktop Wake surface.
- Pre-suspend announcement as evidence for `sleeping`.

</deferred>
