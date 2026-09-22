# Autonomous Engineering OS (AEOS)

Spec of record for the program on branch `orca-x/aeos`. Like its siblings in this directory it is
gitignored and force-added, so `git log -- docs/` cannot see it.

The thesis is not "add an autonomy feature". It is that Orca already owns almost every primitive
this needs, under different names, and the work is **composition plus four missing contracts** —
authority, outcome, completion, and a host that can verify.

## What the reality scan changed

Measured 2026-09-22 before any code was written. Each row replaced an assumption the program
started with.

| Assumed missing | Actually present |
|---|---|
| A Mission ledger | `src/main/runtime/orchestration/` — SQLite. `RunRow`(objective), `TaskRow`(DAG `deps`, status), `WorkerDispatchRow`(`worktree_id`, `agent_terminal_handle`), `DecisionGateRow`, `QuestionRow`, `MessageRow`/`DeliveryRow` with idempotency receipts. RPC-registered via `ORCHESTRATION_METHODS`, driveable headlessly from `src/cli/handlers/orchestration.ts`. No symbol named `Mission` exists anywhere. |
| Human-approval infrastructure | Three independent mechanisms: orchestration gates/questions, `src/shared/plugins/plugin-consent-*`, `src/shared/external-worktree-inbox.ts` |
| A status vocabulary | `config/status-semantics.jsonc`, gate-enforced, contrast floors per role |
| Secret redaction | `src/main/observability/redactor.ts`, three enforcement points |
| Host/fleet identity | `src/shared/fleet-*.ts` + `rpc/methods/fleet.ts` + `cli/handlers/fleet.ts` |
| A worktree authority | `OrcaRuntimeService.createManagedWorktree` — one creator, interactive and headless callers |

## Constitution

```
InfinityOps   strategic prioritization   (GET /api/roadmap/next_action is the only reachable brain)
Orca X        execution reality          (orchestration is the mission spine)
Claude PP     institutional learning
GEX44         resident execution + verification host
OS keychain   secret material            (Orca owns identity/authority/resolution, never bytes)
```

### Seven do-not-builds, each with a measured owner

No second mission ledger · no second status family · no second redactor · no second envelope
(`InfinityMie.Ukdl.Envelope`, wire `ukdl/1.0`) · no second host identity · no second worktree
authority · no second worktree-poll scheduler (`src/main/ipc/worktree-observation-clock.ts`).

### The one new primitive, and its argument

A **Capability Completion** ratchet — the estate's *seventh*, in the shape of the six that exist
(`reliability-gates`, `durability-contracts`, `variant-parity`, `recurring-work-inventory`,
`status-semantics`, `visual-asset-registry`).

`RESUMPTION_FILE.md` carries "The three registries are the Product Solidity Ledger — do not build a
fourth." That sentence is stale (six exist) and is exactly why it must be answered rather than
stepped around. The incumbent for "is this claim backed" is `config/reliability-gates.jsonc`, whose
`assertionRefs` resolve against cited sources. **W3 does not start until a measured
REUSE→EXTEND→CREATE argument names what that registry cannot express.** The working hypothesis is
that it answers *claim-to-evidence* and cannot answer *reachability* — if that proves false, W3
extends `reliability-gates.jsonc` instead and creates nothing.

## Host reality (measured)

| | Workstation | Fork CI | GEX44 |
|---|---|---|---|
| Capacity | **1.8 GB free / 32 GB** | **`runner_id: 0`, starved since 2026-09-13** | 20 CPU, **59.9 GB free**, idle |
| Can verify? | OOM-kills the full suite | no executor at all | **yes** |

Verification capacity, not architecture, is the binding constraint — which is why the host comes
first. GEX44 is **shared** (`cavex`, `dolphin-instrumented`, `faro`, KSR binaries live in that
home), so: user-local toolchain under `~/.orca-toolchain`, system Node 18 never touched, and no
process on that host is killed by anything this program builds.

`gh` with no `--repo` resolves to `upstream` (`stablyai/orca`), whose CI is healthy. Every CI claim
about our fork must pass `--repo jacobo07/orca-x` or it is an answer about someone else's repo.

## Waves

Audit-derived corrections are marked **[A<n>]**.

| # | Wave | Done-gate |
|---|---|---|
| W0 | Isolated worktree `orca-x/aeos` off `09d218fab`; this spec | Clean tree, `node_modules` junctioned **[A14]**, no foreign hunks |
| W1 | GEX44 verification host | Suite runs; every failure classified `platform-only` / `host-environment` / `genuine` — **not diffed** against a workstation full-suite baseline, which does not exist **[A11]**. Adds `orca serve` staying up as an acceptance criterion, because W6 has no substrate without it **[A10]** |
| W2 | GEX44 visible as an **eligible candidate** in the read-only fleet view | The word "admit" is dropped: there is no apply path, and `fleet-placement.ts` says a proposal authorizes nothing **[A12]**. Sample age stated explicitly; shared-host volatility recorded as a limitation **[A13]** |
| W3 | Capability Completion ratchet | REUSE argument first **[A3]**; 7 files not 3 **[A5]**; gate runs standalone — `pnpm lint` is red at HEAD for unrelated localization keys and cannot be the oracle **[A4]**; wired into `pr.yml` because `config/ci-gate-coverage-baseline.txt` is empty and shrink-only **[A1]**, while the evidence records the rung as `BLOCKED — no runner` rather than claiming enforcement **[A2]** |
| W4 | Authority/budget envelope | **Fail-closed**: the host refuses a dispatch carrying no envelope. An optional field is fail-open and the wire doc names this exact defect **[A7]**. Touches the `db.ts` ladder *and* `VERSIONED_POST_V6_COLUMNS` **[A6]**, and states behaviour under federation skew **[A8]** |
| W5 | Outcome Ledger on `TaskRow` | Same two-file schema rule **[A6]**; durability contract entry **[A15]** |
| W6 | Resident Cell v1 on GEX44, ceiling **L2** | Names its coordinator-slot semantics and carries a heartbeat — `getActiveCoordinatorRun` returns one row, so "running forever" either shadows everything or is shadowed **[A9]**. Classified in `recurring-work-inventory.jsonc` with a stated bound; the debt baseline is at 0 and only shrinks **[A15]** |
| W7 | Attention: one projection over the three sources, revision-bound | Names the counter and proves it moves on exactly the set the decision must hold constant **[A16]** |
| W8 | Strategy: read-only `next_action` | Three-state empty answer — not-called / genuinely-empty / rejected must never collapse **[A17]** |
| W9 | Credential broker over `safeStorage` | Every output path crosses `redactor.ts` as a fourth enforcement point, never bypasses it **[A17]** |
| W10 | Minimal surfaces | Real producers only |

## The schema landmine (worth its own section)

`src/main/runtime/orchestration/db.ts` carries `SCHEMA_VERSION` and an `ALTER TABLE … ADD COLUMN`
ladder. `orchestration-schema-version-skew.ts` holds `VERSIONED_POST_V6_COLUMNS`, and
`resolveOrchestrationMigrationStartVersion` returns `Math.min(stored, schema, 6)` when that set is
incomplete.

**A column added to the ladder but not registered makes every existing database replay migrations
from v6.** It is two lines to get wrong and a long night to discover. Every W4/W5 column touches
both files plus a case in `orchestration-version-skew-migration.test.ts`.

## W2, measured: observation and execution share one door

Measured 2026-09-22 after W1. The W2 row above asks for GEX44 as an **eligible candidate in the
read-only view, not an authorized host**. As scoped, that is not representable today:

- The view's members are *this host plus paired runtimes*. SSH targets are explicitly not
  enumerated (`observation.coverage.sshTargets: 'not-enumerated'`), so **pairing is the only way in**.
- Every pairing scope carries execution authority. There are two, `runtime` and `mobile`, and
  `device-registry.ts` says outright that `runtime` holds *"CLI powers"*. **No observe-only scope
  exists.**
- So making GEX44 appear means granting the workstation authority to drive GEX44 — the exact thing
  W2 must not grant — plus minting a pairing credential and running a resident `orca serve` on a
  shared host. W1 found that serve binds `0.0.0.0` with the firewall inactive and writes hooks into
  the host's real agent homes, and those writes are still unreverted.

This is the weld the global `scoped-side-effect-authority` rule names: observe and mutate behind one switch, which
makes a non-mutating observation mode unrepresentable. The fix is additive and belongs in the
pairing layer — an observe-only scope that can reach `status.get` and `diagnostics.memory` and
nothing else. It is a wire change between independently-updated peers, so it follows
`docs/reference/remote-wire-compatibility.md` and needs its own spec, not a slot inside W2.

**What W2 delivered instead:** "a proposal authorizes nothing" was a comment at
`fleet-placement.ts:63`. It is now a check. `fleet.placementView` is driven with a trap runtime
that counts every access: zero, against a positive control proving the trap records. Its result
must survive a JSON round trip unchanged, so it can carry no function or handle. Making the view
touch the runtime, or return a callable, each turns it red. The remote half was already pinned: the
observer's `call` type admits only `'status.get' | 'diagnostics.memory'`, both pure getters.

**Owner decision, not engineering:** either authorize a pairing, accepting execution reach over
GEX44, or approve the observe-only scope as its own wave. GEX44 is not made eligible until one is
chosen.

## W3, measured: the REUSE argument, and why nothing was created

The W3 row requires a REUSE→EXTEND→CREATE argument before a seventh ratchet. Measured 2026-09-22
against both candidate incumbents:

| Incumbent | Unit | Answers | Sees a missing consumer? |
|---|---|---|---|
| `config/reliability-gates.jsonc` (93 gates) | a claim | is it backed by tests? | **no** — a fully tested, unreachable capability passes |
| `config/mobile-capability-aperture-*` | an RPC method, enumerated from `defineMethod` | is it reachable? | **yes, already** |

The second one already answers W3's question. `pnpm check:mobile-aperture` on this revision:

```
260/567 host RPC methods reachable (45.9%), 307 host-only, 307 baselined
205/260 allowlisted methods named by mobile source, 55 reach-without-surface
```

That is the three-rung taxonomy W3 set out to build: host-only · wire-reachable · consumer-reachable.
"Reach-without-surface" is *a capability that exists which no consumer reaches*. It is structurally
enumerated, positive-controlled, shrink-only, and carries a stale clause.

**Verdict: REUSE. Nothing created.**

- Where reachability can be enumerated structurally, the incumbent owns it.
- What remains is a proposal with no apply path, or a field with no producer. That has **no
  structural population**, so a registry for it would be declared by hand — what the aperture audit
  itself calls *"a drift registry, not an inventory."* The honest home for such a check is the
  domain gate that can enumerate it. `check:orchestration-migration` could, for example, grow a
  column-with-no-writer check.
- The spec's working hypothesis was half right: reliability-gates cannot answer reachability. It
  does not need to, because the aperture already does.

**Complementarity proven on the incumbents, not asserted.** Two drills, restore SHA-256 verified:

| Drill | Aperture | Evidence at the same moment |
|---|---|---|
| unclassify `fleet.placementView` | **red** — names it as an unclassified host-only method | **green** — 11/11 fleet tests |
| baseline an entry that does not exist | **red** — `[stale-baseline] … 1 no longer exist` | — |

A capability can hold complete test evidence and lose its reachability classification, and only
the aperture notices. The reverse also holds: the aperture never reads a test. The two owners are
independent, which is why neither should absorb the other.

Observed, not fixed: the aperture audit's prose still says 565 / 305 while the gate measures 567 /
307. The gate is right and the prose drifted — a count written beside an inventory goes stale.

## Authority

Ceiling is **L2**: isolated worktree, local code, tests, commits. No push, no PR, no merge, no
external mutation, no credential use beyond what already exists on the host. L3 is a separate Owner
decision after three missions pass Product Reality.

## Ownership

No wave touches the files `RESUMPTION_FILE.md` reserves for other panes (working-set
capture/save/store, `SleepReclaimAuthorization*`, agent-session presence files), and this program
owns no file in the main checkout. `.planning/` is untracked here and this program does not write
to the D1 milestone's copy.
