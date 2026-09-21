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

| Slice                                                          | State                                                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Presence projection, reader, claim-key identity                | landed `326a31df5`, `20db169ad`                                                              |
| `agentSession:readLivePresence` (renderer read)                | landed `26d0fb75c`                                                                           |
| Class B detection + `agentSession:liveCollision` push          | landed `c8626a2a7`; owning-window warning toast `fc7307fe2`                                  |
| Class A gate on AI Vault resume (Back / Continue / revalidate) | landed `9ae0aecf8`, copy `b8030f2b4`                                                         |
| Class A gate on Sleep launch and cold restore                  | landed at the spawn: RED `143013dbc`, `175c81eb4`, `6352d715c`                               |
| Reservation for simultaneous Class A resumes                   | landed `123c07615` (RED), `38a5137ed`, `f539fa099`, `08d9b2933`, e2e `1737c642a`             |
| Class A gate on working-set (snapshot) restore                 | landed at the spawn (revival is a pane cold restore)                                         |
| Runtime ensure (web, runtime panes) on the same reservation    | landed: RED `374888067`, `9ab2316c6`, `e0d52c924`, `c23065435`, `ca93d6d78`                  |
| Mobile AI Vault resume (current mobile + current host)         | landed: RED `657cb02f3`, `862da67bf`, `3a5e03911`, `f9f925335`, e2e `90a775c0e`              |
| Mobile typed-command fallback                                  | unguarded compatibility leg, inventoried (`b1629058f`)                                       |
| Execution-context fidelity (recorded directory, account home)  | landed: RED `cac3d209f`, `0a5b2a0f6`, fix `80a9b2af6`, `ab52977ff`, `882e35b58`, `0763c9c40` |
| Class B Back semantics                                         | unmeasured; interactive probe blocked by the folder-trust prompt                             |
| Shared-live rail indicator, go-to-open-session                 | not started                                                                                  |
| Real-provider product reality                                  | not run                                                                                      |

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

| Materializer                                            | Initiated | Class | Status                                                             |
| ------------------------------------------------------- | --------- | ----- | ------------------------------------------------------------------ |
| AI Vault resume                                         | user      | A     | guarded (dialog + reservation + spawn gate)                        |
| Per-pane "Resume this session"                          | user      | A     | guarded: dialog + reservation, then gated respawn (`4f7fb4b8f`)    |
| Sleep launch into a new tab (activation, mobile)        | automatic | A     | guarded at spawn; limit: record cleared before spawn               |
| Pane cold restore                                       | automatic | A     | guarded at spawn; refusal keeps the record (`be116a07e`)           |
| In-place hibernation wake                               | automatic | A     | guarded at spawn (same path as cold restore)                       |
| Working-set row revival                                 | automatic | A     | guarded at spawn (lazy sleep record → cold restore)                |
| Runtime ensure: web AI Vault, runtime-hosted pane       | user/auto | A     | guarded: registry adopts, a new spawn crosses the gate             |
| Host-side `terminal.create` with a recorded session     | any       | A     | guarded at the controller spawn (`c23065435`)                      |
| Mobile AI Vault resume (eligible session, current host) | user      | A     | guarded: `terminal.ensureAgentSession`, nothing created on refusal |
| Mobile AI Vault typed-command fallback                  | user      | A     | **not guarded**: old host, legacy_required, Codex, cwd ≠ workspace |
| Legacy text-command fallback (old host, `afterTabId`)   | user      | A     | **not guarded**: the session travels only as command text          |
| CLI                                                     | —         | —     | no Orca-selected resume; a typed `claude --resume` is the user's   |
| Provider `/resume` picker                               | provider  | B     | post-effect notice to the owning window                            |
| SSH                                                     | any       | —     | unsupported: no claim key, proceeds unreserved                     |

## Runtime ensure (2026-09-17)

`terminal.ensureAgentSession` is the only runtime path that resumes an exact session. Its callers
are the web AI Vault (`web-runtime-session.ts`) and the pane transport for runtime-hosted panes
(`remote-runtime-pty-transport.ts`); mobile and the CLI do not call it. The host always resumes
(`automatic` is rejected) and routes through `ClaimedAgentPtyOwnerRegistry` in the `pty.ts`
controller.

The registry keeps what only it can do: joining a claim that is being spawned, adopting a live
owner (so a lost response retried adopts rather than duplicates), reconciling daemon and relay
owner listings, the cross-worktree conflict, generation fencing and capacity. It could not see a
desktop reservation or a desktop pane, so a spawn it would start now crosses the same gate as
`pty:spawn` (`9ab2316c6`): the host passes the raw session (`agentSessionResumeSubject`), the gate
reads presence, refuses a claim key it cannot reproduce, and holds the reservation for the ensured
tab with no window owner. Release: spawn throw, PTY teardown of that tab, live handoff, bounds.
A client disconnect after the spawn does not release it; the runtime keeps running.

The gate is installed in shared startup as well as by the window registration, because
`orca serve` never opens a window (`e0d52c924`). Refusals are four RPC codes
(`agent_session_live_elsewhere`, `_multiple_live_owners`, `_materializing`, `_presence_unknown`),
disjoint from the two a shipped client falls back on, so an old client fails closed. A runtime pane
gets a plain shell plus `agentResumeRefused`, like desktop; the web AI Vault shows the
`paneResume.blocked` copy (`ca93d6d78`). No remote caller has a Continue override.

Inventory: the ratchet sweeps `mobile/src` and counts `terminal.ensureAgentSession` requests
(`559f424cb`); since `b1629058f` it also sweeps typed-command launchers and has a `legacy-fallback`
class (see the mobile section below).

## Mobile AI Vault (2026-09-17)

Mobile knew the exact session and still created a plain terminal and typed the resume command, so
only the after-the-fact SessionStart notice saw it. `materializeMobileAiVaultResume`
(`mobile/src/session/ai-vault-resume-materialization.ts`) now sends the selection to
`terminal.ensureAgentSession`; mobile computes no claim key. A refusal throws before anything is
created (the panel shows the desktop copy and does not navigate); created and adopted results
activate the returned tab. Double tap and lost-response retry reach the host, whose registry adopts.

The typed command remains, as an unguarded leg, only when:

- the host does not advertise `agent-session.host-authority.v1` (plus the OMP path capability for
  OMP), read from `status.get` before sending; an unreadable status counts as not advertised;
- the host answers `agent_session_legacy_required` or `method_not_found`
  (`src/shared/agent-session-legacy-fallback.ts`, shared with web);
- the session needs its recorded context and the host does not advertise
  `agent-session.resume-context.v1` (see the next section) — a distinct reason,
  `host-lacks-context-fidelity`, because that host answers and would resume elsewhere;
- the session is recorded outside the workspace being resumed into, or there is no startup plan.

Refusals, unknown replies, timeouts and other errors never fall back.

| Mobile  | Host                                        | Result                                                 |
| ------- | ------------------------------------------- | ------------------------------------------------------ |
| current | current                                     | guarded for eligible sessions                          |
| current | no ensure method                            | typed command, unguarded                               |
| current | ensure, but predates the gate (`9ab2316c6`) | registry only: adopts its own owners, blind to desktop |
| current | answers legacy_required                     | typed command, unguarded                               |
| older   | any                                         | typed command, Class B only                            |

Mobile only resumes into local targets, so SSH never reaches this path.

## Execution-context fidelity (2026-09-17)

A resume can be collision-safe and still be the wrong resume. `terminal.ensureAgentSession` took
the worktree selector as its only location input, so every resume started at the workspace root
(`orca-runtime.ts`, the `?? workspace.path` fallback) with the host's settings environment — while
its own sibling `terminal.createAgentSession` had accepted a validated `startupCwd` since both were
born in `b232df732`. Two things followed, and both were measured before anything changed:

- a session recorded in a subdirectory resumed at the workspace root;
- a Codex session resumed under whichever `CODEX_HOME` the host carried, because the spawn layer
  resolves the account home from `resumeProviderSession` and ensure never passed it.

The web client made this a drop rather than an absence: `web-runtime-session.ts` holds `cwd`, `env`
and `envToDelete` (its legacy leg sends all three) and omitted them from the guarded request.

**What each side owns now.** The directory crosses the wire as `startupCwd`, because no host-side
record maps a vault session to a directory at ensure time. The account home does not: the host
resolves it from the transcript path the request already carries, through the authority that
already exists (`prepareCodexSessionResume`, `aiVault:prepareSessionResume`), which also owns the
real-home strip and the cross-account repin. Clients name a file; they never name a home.

**The directory is constrained, unlike a new terminal's.** `resolveTerminalStartupCwd` is
deliberately unconstrained (#7685) so a new terminal can open outside the worktree. A resume may
not: `agent-session-resume-startup-cwd.ts` refuses anything outside the workspace being resumed
into with `agent_session_resume_context_unauthorized`, so a paired client cannot start an agent
anywhere on the host. That code is not in the legacy fallback list, so a refusal can never become a
typed command. A missing directory is not silently rooted either — the spawn fails loudly.

**Capability.** `agent-session.resume-context.v1` states the guarantee, not the method: an older
host advertising `agent-session.host-authority.v1` answers and resumes elsewhere, and because the
ensure params are `.strict()`, the added field would be rejected outright rather than ignored.
Clients read it from `status.get` before sending; when it is absent and the session needs its
context, both fall back to the typed command that reproduces it. Mobile reports that as
`host-lacks-context-fidelity`, kept apart from the method being missing. One shared predicate
(`agent-session-resume-context.ts`) decides "needs recorded context" for both clients: Codex
always, plus any session recorded away from the workspace root.

| Client → host                             | Result                                                     |
| ----------------------------------------- | ---------------------------------------------------------- |
| current → current                         | guarded and context-faithful                               |
| current → ensure without `resume-context` | typed command, unguarded, reason states the capability gap |
| current → no ensure                       | typed command, unguarded                                   |
| older client → any                        | typed command; only the after-the-fact notice sees it      |

Runtime-hosted panes carry no directory at that layer at all (`remote-runtime-pty-transport.ts`
has no cwd in scope), so they gain the account-home fix and still resume at the workspace root; the
tab's own `startupCwd`, which the host already persists, is the open follow-up.

Evidence: 7 host cases, 4 web cases, 33 mobile cases; the containment mutation reds exactly the two
escape cases, and inverting the shared predicate reds one mixed-version case in each client.

Evidence: 28 unit cases; 12 client mutations and 7 inventory mutations or plants caught; e2e
`90a775c0e` drives the mobile module over the real E2EE socket as a `mobile`-scope device and is
red with the old typed path and with "materializing" widened into the fallback.

Pane handling (`be116a07e`): a refusal shows the `resume-refused` banner, clears the launch
config it registered and keeps the sleep record. A refused dormant working-set row still becomes
an ordinary live shell once its PTY binds.

Evidence: 10 main-side mutations, 2 pane mutations, 3 inventory drills caught; real-app e2e
`74c586368` fails with the gate bypassed.

Inventory ratchet: `config/existing-session-materializers.jsonc`, enforced by
`existing-session-materializer-inventory.test.ts` (`367378740`). A new resume-planner call, a
changed count or a stale entry fails; a spawn-gate entry must name its carrier.

Limits: a refused sleep launch leaves a plain-shell tab, and its record was already cleared
before the spawn (reserving before tab creation touches twelve test files). The remote-host AI Vault path carries a session without
`launchAgent`, so the gate treats it as having nothing to resume (it runs over a connection the
gate skips anyway).

## Known limits

- An agent exit Orca does not detect (shells without OSC 133) leaves a hook row that can read as
  live. Installing the provider's `SessionEnd` hook is the follow-on fix.
- SSH workspaces have no execution namespace yet, so their candidates resolve to UNKNOWN.
- Account roots are merged per agent, so two accounts sharing a raw id would conflict; provider
  ids are UUIDs, so this is conservative rather than observed.
