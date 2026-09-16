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

## Known limits

- An agent exit Orca does not detect (shells without OSC 133) leaves a hook row that can read as
  live. Installing the provider's `SessionEnd` hook is the follow-on fix.
- SSH workspaces have no execution namespace yet, so their candidates resolve to UNKNOWN.
- Account roots are merged per agent, so two accounts sharing a raw id would conflict; provider
  ids are UUIDs, so this is conservative rather than observed.
