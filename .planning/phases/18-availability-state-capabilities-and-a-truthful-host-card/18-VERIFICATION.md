---
phase: 18-availability-state-capabilities-and-a-truthful-host-card
status: human_needed
verified: 2026-10-27
owed:
  - "The host card on a REAL DEVICE or a labelled emulator (/gsd-verify-work 18)"
  - "A live status.get read of hostAvailability from a disposable serve host"
---

# Phase 18 Verification: availability state, capabilities and a truthful host card

Labels: **UNIT laptop** = vitest on this laptop. **UNIT GEX44** = mobile vitest in a disposable GEX44 root with
teardown proof (18-gex44-mobile-vitest.ps1/.sh). **GATE** = `pnpm run check:host-card-claims` on the real tree.
**MUTANT** = a planted change on the real tree, caught, then restored to HEAD. Nothing here is REAL DEVICE or
OWNER-OBSERVED.

## Success criteria

| SC | Criterion | Evidence | Label | Verdict |
|---|---|---|---|---|
| SC1 | Power, Orca and connectivity are three fields; no live answer composes to unknown, never powered-off | 18-01 (4177bf3bb, 27f354622, b2ae2fa06): `host-availability.test.ts` matrix `covers 2880 rows`; status.test.ts 7/7. Re-run here: `vitest run src/shared/host-availability.test.ts config/scripts/check-host-card-claims.test.mjs` exit 0, `Tests 58 passed (58)`. P18-M0 (composer returns powered-off when not connected) CAUGHT: exit 1, `src/shared/host-availability.test.ts (26 tests \| 1 failed)` | UNIT laptop + MUTANT | PASS |
| SC2 | Capabilities carry value + reason + evidence, announced additively behind `host.availability.v1`; Node Manifest change coordinated, not written | 18-01 status.get `hostAvailability` (schema 1) behind `host.availability.v1`; 18-02 presenter (64bbb2efa, 4c1beb905, ec259f255) on GEX44: 6 files 80/80, `TEARDOWN procs=0 root=absent`. `18-NODE-MANIFEST-PROPOSAL.md`: additive optional `node.host_capabilities`, C:\ox porcelain and HEAD identical before/after (`cmp`: PORCELAIN IDENTICAL, HEAD IDENTICAL) | UNIT laptop + UNIT GEX44 | PASS (live status.get read owed) |
| SC3 | A gate fails when the card can render a power-loss state without evidence or a control without a backend effect | 18-03: `pnpm run check:host-card-claims` exit 0: `check-host-card-claims: 22 labels classified, 2 controls classified, 589 host RPC methods known, no unevidenced power-loss state, no control without an effect.` Gate test 32/32 (RED 18 failed / 14 passed at 6762cbc00, GREEN 54a2af764). P18-M1a, M1b, M2a, M2b CAUGHT and RESTORE_VERIFIED (table below). CI step after check:workspace-surface-claims in pr.yml | GATE + UNIT laptop + MUTANT | PASS |

## Mutant drills (real tree, 18-03)

Protocol per drill: `git diff --quiet -- <files>` exit 0 before the plant; plant by exact single-occurrence
replacement; PLANT_CONFIRMED = `git diff --stat` names only those files and every `-U0` diff line is a planted or
replaced anchor line; CAUGHT = command exit non-zero with the expected rule line; restore with
`git checkout -- <files>` only after the diff was re-read unchanged; RESTORE_VERIFIED = `git diff --quiet` exit 0 and
the command exits 0 again. `git status --porcelain -- mobile src config` was empty before and after.

| Mutant | Files | PLANT_CONFIRMED | CAUGHT (command, exit, decisive line) | RESTORE_VERIFIED |
|---|---|---|---|---|
| P18-M0 composer: not-connected returns `powered-off` with transport-observed evidence | src/shared/host-availability.ts | yes, `1 file changed, 3 insertions(+)` | `vitest run src/shared/host-availability.test.ts`, exit 1, `src/shared/host-availability.test.ts (26 tests \| 1 failed)` | diff-quiet 0; rerun exit 0, `Tests 26 passed (26)` |
| P18-M1a `power.unknown` text -> `Powered off` | presenter | yes, `1 file changed, 1 insertion(+), 1 deletion(-)` | `pnpm run check:host-card-claims`, exit 1, `label "power.unknown" must say unknown, but reads "Powered off"` and `host-availability-presentation.ts:20 power-loss text "Powered off" on "power.unknown" — only power.sleeping, power.hibernating, power.powered-off may say it` | diff-quiet 0; gate exit 0, 22 labels |
| P18-M1b add `power.powered-off: 'Powered off'`, classified with `evidence: []` | presenter, jsonc | yes, `2 files changed, 2 insertions(+)` | gate, exit 1, `power-loss label "power.powered-off" has no evidence — unreachable is not powered off` | diff-quiet 0; gate exit 0 |
| P18-M2a Wake Pressable `testID="host-card-wake"`, classified effect rpc `host.wake` | card, jsonc | yes, `2 files changed, 7 insertions(+)` | gate, exit 1, `action "host-card-wake": rpc "host.wake" is not a host RPC method — an effect with no backend` | diff-quiet 0; gate exit 0 |
| P18-M2b same Pressable, no testID, no jsonc entry | card | yes, `1 file changed, 5 insertions(+)` | gate, exit 1, `MobileHostCard.tsx:149 Pressable has no literal testID — a control nobody can classify` | diff-quiet 0; gate exit 0 |

## Product Reality projection (SCRIPTED, unit — never REAL DEVICE)

Expected card text from the presenter tables (18-02 presenter tests on GEX44), by the brief's rows:

| Row | Situation | Expected availability line | Capability line | Label |
|---|---|---|---|---|
| A | Desktop host, UI open, answered on this connection | `Awake · Orca open` | from the announcement | SCRIPTED (unit) |
| B | Serve host ready, or desktop runtime with window closed | `Awake · Host Service running` or `Awake · Orca running, window closed` | from the announcement | SCRIPTED (unit) |
| C | Host unreachable | `Power unknown · Orca unknown` | last announcement this session (wake `not set up`, power-on `unknown`) | SCRIPTED (unit) |
| D | Host asleep (indistinguishable from C to the phone) | `Power unknown · Orca unknown` | as C | SCRIPTED (unit) |
| E | Host powered off (indistinguishable from C) | `Power unknown · Orca unknown` | as C | SCRIPTED (unit) |
| F | Relay down, LAN gone | `Power unknown · Orca unknown` | as C | SCRIPTED (unit) |
| G | Connected but no current status.get answer | `Power unknown · Orca unknown` | as C, or `Capabilities unknown` with no answer this session | SCRIPTED (unit) |
| M | Protocol versions incompatible | `Awake · Orca version mismatch` (warning tone) | from the announcement | SCRIPTED (unit) |

No row shows a power-loss word: the label table has no power-loss key, and the gate refuses one without a producer
and evidence (P18-M1a/M1b).

## Owed, not claimed

1. **The card on a REAL DEVICE or a labelled emulator** — `/gsd-verify-work 18`. Nothing in this phase ran on a phone.
2. **A live status.get read of `hostAvailability` from a disposable serve host.** Not run: the laptop's `out/main`
   (built 2026-10-27 16:54) predates 18-01 (d019f09f4, 18:01) and has no `hostAvailability` in `out/main/index.js`,
   so a run would read the old producer. A rebuild (`build:electron-vite`) is not cheap on this 8 GB laptop. Recipe:
   STATE.md GEX44 serve host, including `pnpm rebuild node-pty` before `build:electron-vite`; read `status.get` as a
   SCRIPTED CLIENT and record `capabilities` includes `host.availability.v1` and `hostAvailability.schema === 1`,
   with teardown proof.

## Named residual

The host actions sheet (reconnect, disconnect, edit, remove; phone-local) is outside the gate's card scope. The gate
classifies the card's `host-card-actions` control as navigation to that sheet; what the sheet offers is not checked.

## Decision traceability

| Decision | Where it is held | Evidence |
|---|---|---|
| D-01 three fields, one shared module | `src/shared/host-availability.ts` (power / orca / connectivity) | 18-01 matrix; gate reads its vocabularies |
| D-02 no response is unknown, never powered-off | `composeHostAvailability` not-connected branch | P18-M0 CAUGHT; gate G3/G4; P18-M1a/M1b CAUGHT |
| D-03 orca from what the host reports (runtime, window status, protocol compat) | `composeOrca` / `composeReadyOrca` | 18-01 matrix (2880 rows); orca labels classified with live-response evidence |
| D-04 six capabilities with value, reason, evidence | `HOST_CAPABILITY_IDS` / `parseHostAvailabilityAnnouncement` | 18-01 tables; gate G1 vocabulary per family |
| D-05 capabilities additive in status.get behind `host.availability.v1`; old hosts read unknown | `parseHostAvailabilityAnnouncement` (`host_did_not_announce`) | 18-01 tables; label `capability-value.unknown` evidence [] |
| D-06 Node Manifest is DWS-owned; proposal only | `18-NODE-MANIFEST-PROPOSAL.md` | C:\ox porcelain + HEAD identical (cmp) |
| D-07 optional fields only | status.get `hostAvailability` behind `host.availability.v1` | 18-01 status.test.ts; proposal Rule 1 section |
| D-08 card renders a pure presenter's projection | `presentHostCardAvailability`, `HOST_CARD_LABELS` | 18-02 GEX44 80/80; gate G1 requires the card import |
| D-09 English literal copy, no new i18n mechanism | `HOST_CARD_LABELS` literals | 18-02 presenter; the gate reads the literals in place |
| D-10 presentation-table gate | `config/host-card-claims.jsonc`, `check-host-card-claims.mjs` | GATE exit 0; 32/32; M1a/M1b/M2a/M2b CAUGHT |
| D-11 mobile tests on GEX44 disposable root | `18-gex44-mobile-vitest.ps1/.sh` | 18-02 runs, `TEARDOWN procs=0 root=absent` |
| D-12 never push, no Owner-PC effects | this phase | no push, no merge; no Owner-PC process touched |
