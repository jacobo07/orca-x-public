---
covers:
  [
    live-session-collision-guard,
    live-agent-session-presence,
    resume-collision,
    esta-sesion-ya-esta-abierta
  ]
tier: T3
status: in-progress
---

# Live Session Collision Guard

## Problem

A resumable agent session (Claude Code, Codex, …) can be live in one pane while another pane
resumes the exact same provider session. Nothing tells the user. The warning must mean exactly
one thing: **this provider session has a live runtime somewhere else right now.**

## What already exists (measured 2026-09-16, HEAD `4a90eb863`)

| Concern                                                 | Owner                                                                                                                                                                                                |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical identity                                      | `canonicalizeAgentSessionIdentity` + `AgentSessionClaimSigner.createClaim` (`src/main/runtime/agent-session-claim-identity.ts`). Digest over agent, provider session key/id and execution namespace. |
| Execution namespace                                     | `OrcaRuntime.getAgentSessionExecutionNamespace`. Local only; SSH returns null. Account roots are merged per agent (conservative).                                                                    |
| Claimed owners, reservation, single-flight, generations | `ClaimedAgentPtyOwnerRegistry` (`src/shared/claimed-agent-pty-owner.ts`). Reached only by `OrcaRuntime.ensureAgentSession`; desktop IPC spawns pass `agentSessionEnsure: undefined`.                 |
| Provider session per pane                               | `agentHookServer.lastStatusByPaneKey` (main process, all windows). **Hydrated from `last-status.json`**; only `runtimeObservedStatusPaneKeys` marks rows seen this runtime.                          |
| Pane → PTY, PTY liveness                                | `getPtyIdForPaneKey` (`src/main/ipc/pty.ts`), `provider.probePtyLiveness` (true / false / null).                                                                                                     |
| Hook transport                                          | Fire-and-forget curl, 1.5 s, output discarded, always exit 0. Orca cannot block a provider.                                                                                                          |

## Seams

- **Class A — Orca selects the session** (AI Vault resume, Sleep launch, cold restore, Mobile/remote
  ensure, future working-set revival). Identity is known before spawn → guard before materialization.
- **Class B — the provider selects** (`/resume` inside the TUI, `claude --resume` picker, Codex
  picker). Orca learns identity from `SessionStart` after the process has loaded the session.
  Only post-selection detection is truthful; the safe control is holding the pane's input before
  the first prompt. The feature must never be described as preventing the second process here.

## Presence contract

Presence is a **projection over current runtime evidence**. Nothing about liveness is persisted.

Per candidate pane whose identity matches:

| hook row seen this runtime | PTY bound to pane | verdict                                           |
| -------------------------- | ----------------- | ------------------------------------------------- |
| yes                        | live              | LIVE (here or elsewhere)                          |
| yes                        | proven absent     | STALE — reconcile, never warn                     |
| yes                        | unknown / unbound | UNKNOWN                                           |
| no (hydrated only)         | live or unknown   | UNKNOWN — process may be alive, agent unconfirmed |
| no (hydrated only)         | absent / unbound  | DORMANT — ignored                                 |

A candidate whose identity cannot be resolved (no namespace) but whose raw session id matches is
UNKNOWN, never "different".

Aggregate, in priority order: MULTIPLE LIVE OWNERS elsewhere · LIVE ELSEWHERE · UNKNOWN ·
LIVE HERE · NO LIVE OWNER. Stale and unknown panes are always reported alongside.

Sleep records, working-set manifests and durable bindings are never inputs.

## Collision contract

- Warning copy exists per state: live in another pane; live in several panes; uncertainty.
  The uncertainty state never uses the "ya está abierta" copy.
- **Atrás** (Class A): cancel before spawn, no side effect. (Class B): decided after measuring
  whether a provider exit without a prompt mutates the session.
- **Continuar**: a one-shot override bound to the identity and to the set of owner generations
  the dialog showed. Revalidated at the point of effect: collision gone → normal path; owner set
  changed → re-confirm. Consumed once. Never stored as a preference.
- A deliberate duplicate is recorded as an additional owner; nothing overwrites the first.
- Continuar is offered only where provider concurrency semantics permit it; unknown semantics
  are stated in the copy.

## Acceptance

Goldens: same title / different sessions → no collision · same cwd / different sessions → no
collision · different titles / same session → collision · hydrated row → no collision ·
stale owner → no warning · unknown stays unknown · second window sees the owner · two
simultaneous Class A resumes cannot both pass · Atrás materializes nothing · Continuar
revalidates and is consumed once.

Mutations that must go red: key by title, key by cwd, treat hydrated as live, skip effect-time
revalidation, bypass reservation, reusable override.

## Rollback

Every slice is additive and path-scoped; reverting a commit removes its behaviour. The Class A
preflight is a new IPC/RPC method name, so an older peer fails closed rather than skipping it.

## Status (2026-09-16)

| Slice                                                          | State                                                                            |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Presence projection, reader, claim-key identity                | landed `326a31df5`, `20db169ad`                                                  |
| `agentSession:readLivePresence` (renderer read)                | landed `26d0fb75c`                                                               |
| Class B detection + `agentSession:liveCollision` push          | landed `c8626a2a7`; owning-window warning toast `fc7307fe2`                      |
| Class A gate on AI Vault resume (Back / Continue / revalidate) | landed `9ae0aecf8`, copy `b8030f2b4`                                             |
| Class A gate on Sleep launch and cold restore                  | landed at the spawn: RED `143013dbc`, `175c81eb4`, `6352d715c`                   |
| Reservation for simultaneous Class A resumes                   | landed `123c07615` (RED), `38a5137ed`, `f539fa099`, `08d9b2933`, e2e `1737c642a` |
| Class A gate on working-set (snapshot) restore                 | landed at the spawn (revival is a pane cold restore)                             |
| Class B Back semantics                                         | unmeasured; interactive probe blocked by the folder-trust prompt                 |
| Shared-live rail indicator, go-to-open-session                 | not started                                                                      |
| Real-provider product reality                                  | not run                                                                          |

Measured: Claude Code 2.1.273 `-p --resume <id>` returns the same session id.

## Materialization reservation

Presence sees a session only once its provider reports SessionStart, so the unprotected interval
was the whole launch (tab mount, spawn, provider boot), not an IPC round-trip.
`agentSession:reserveMaterialization` reads presence and then, with nothing awaited, checks and
sets a reservation in `LiveSessionMaterializationReservations` (main, one per process):

- key: the canonical claim key; owner: one operation id in one window (`webContents` id);
- reported to others as `materializing`, which live, multiple and unknown owners outrank;
- Continue sends back the exact collision it answered (`accept`); granted only if unchanged;
  an accepted in-flight collision is an unreserved one-shot duplicate and does not displace it;
- ends on: live owner seen in the reserved tab (handoff, read-time), PTY teardown of that tab,
  owner release (launch threw or turned runtime-routed), window destroyed, never spawned within
  30 s, or spawned but never reported within 120 s. Expiry is evaluated on read; no timer.

Limits: SSH (no claim key) proceeds unreserved; a tab attached after the 30 s ceiling runs
unprotected; the reservation is per tab, so a split pane exiting in the same tab releases it.

## Resume spawn gate (one authority for every Orca-selected resume)

Rule: any Orca-owned path that turns an existing provider session into a new runtime must
cross the same presence check and the same claim-keyed reservation before the effect. The
reason (vault, sleep, restore, working set) is provenance, never part of the key.

Every local desktop resume ends in `pty:spawn` carrying `resumeProviderSession`, so the gate
lives there (`decideResumeSpawn`, installed by `registerAgentSessionLivePresenceHandlers`):

- presence is read for the spawning pane, then, with nothing awaited, the reservation decides;
- a hold already attached to the spawning tab (the vault's own operation) proceeds;
- a one-shot permit, recorded only when the vault dialog's Continue was granted and bound to
  the tab it attached, proceeds once; automatic spawns can never create or consume one;
- otherwise live / multiple / unknown / starting elsewhere is refused, and a free session is
  reserved for the spawning tab (released on spawn throw, PTY teardown, window close, handoff);
- a refusal spawns a plain shell (no command, launch config, agent or sequenced startup) and
  replies `agentResumeRefused`; it never falls back to launching a fresh provider session;
- expiry is cleanup, not proof: every decision re-reads presence first.

| Materializer                                     | Initiated | Class | Status                                                       |
| ------------------------------------------------ | --------- | ----- | ------------------------------------------------------------ |
| AI Vault resume                                  | user      | A     | guarded (dialog + reservation + spawn gate)                  |
| Per-pane "Resume this session" (in progress)     | user      | A     | not integrated: types into a live shell, never spawns        |
| Sleep launch into a new tab (activation, mobile) | automatic | A     | guarded at spawn; limit: record cleared before spawn         |
| Pane cold restore                                | automatic | A     | guarded at spawn; refusal keeps the record (`be116a07e`)     |
| In-place hibernation wake                        | automatic | A     | guarded at spawn (same path as cold restore)                 |
| Working-set row revival                          | automatic | A     | guarded at spawn (lazy sleep record → cold restore)          |
| Runtime-routed ensure (web, mobile, CLI)         | remote    | A     | not integrated: own `ClaimedAgentPtyOwnerRegistry` authority |
| Provider `/resume` picker                        | provider  | B     | post-effect notice to the owning window                      |
| SSH                                              | any       | —     | unsupported: no claim key, proceeds unreserved               |

Pane handling (`be116a07e`): a refusal shows the `resume-refused` banner, clears the launch
config it registered and keeps the sleep record. A refused dormant working-set row still becomes
an ordinary live shell once its PTY binds.

Evidence: 10 main-side mutations, 2 pane mutations, 3 inventory drills caught; real-app e2e
`74c586368` fails with the gate bypassed.

Inventory ratchet: `config/existing-session-materializers.jsonc`, enforced by
`existing-session-materializer-inventory.test.ts` (`367378740`). A new resume-planner call, a
changed count or a stale entry fails; a spawn-gate entry must name its carrier.

Limits: a refused sleep launch leaves a plain-shell tab, and its record was already cleared
before the spawn (reserving before tab creation touches twelve test files). The per-pane
"Resume this session" being built in `pane-session-resume-capability.ts` types into a live
shell, so it never crosses `pty:spawn`; it must reserve through the IPC authority itself and be
classified in the inventory. The remote-host AI Vault path carries a session without
`launchAgent`, so the gate treats it as having nothing to resume (it runs over a connection the
gate skips anyway).

## Known limits

- An agent exit Orca does not detect (shells without OSC 133) leaves a hook row that can read as
  live. Installing the provider's `SessionEnd` hook is the follow-on fix.
- SSH workspaces have no execution namespace yet, so their candidates resolve to UNKNOWN.
- Account roots are merged per agent, so two accounts sharing a raw id would conflict; provider
  ids are UUIDs, so this is conservative rather than observed.
