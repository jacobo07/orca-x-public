---
covers: [universal-backlog, intent-ledger, backlog, candidate-intent, backlog-inbox, backlog-reconciliation, conversation-harvest, chatgpt-export-import, executor-lanes, run-when-claude-available, backlog-bulk-execute, backlog-infinityops-bridge]
tier: T3
status: approved-plan
branch: orca-x/universal-backlog
base: main 49b1415e7
approved: 2026-09-29 (Owner, "aprobar")
---

# Universal Backlog — Orca X Intent Ledger

## Why

Useful intent (tasks, prompts, bugs, ideas, decisions, research, follow-ups) is generated across
many chats, models, repos and devices and is lost when any of them goes away. The Universal Backlog is
Orca X's durable, provenance-aware, evidence-reconciled system of record for **unfinished intent**
across every project and chat. It is not a task runner.

## Laws

1. **Conversation is a source of intent, not the system of record.** Accepted intent no longer depends
   on finding its chat; provenance to that chat is kept.
2. **Detected intent is not verified pending work.** Harvested text becomes a *candidate*; it becomes
   canonical only by an explicit accept, and "still due" is a reconciliation verdict with evidence.
3. **Backlog is not execution.** Execution stays with its owners; the backlog links to them and reads
   their state, never copies it.
4. **Project is an attribute, not the boundary.** 0..n projects per item; none = Unassigned; a guessed
   mapping is labelled inferred.
5. **Source, executor and project are separate dimensions.**
6. **Trust is asymmetric; evidence outranks executor reputation.** Lower-trust code never promotes
   itself to a canonical branch.
7. **Unknown stays unknown.** No match ≠ not implemented; no open task ≠ abandoned; similarity ≠ same
   item; model confidence ≠ evidence; absent count ≠ 0.

## Ownership (measured 2026-09-29 on main 49b1415e7)

| Concept | Owner | Backlog relation |
|---|---|---|
| Tasks page | `TaskPage.tsx` — live view of GitHub/Linear/Jira items, no local store | CONNECT (evidence + link) |
| Agent work | orchestration `tasks` (`src/main/runtime/orchestration/db.ts`, run-scoped, `TaskStatus`) | CONNECT: execution target via `taskCreate` / dispatch admission |
| Project identity | `Project` / `Repo` (`src/shared/project-types.ts`) in PersistedState | ADOPT `Project.id` |
| Conversations | `ConversationStore` (one JSON per conversation) | ADOPT `ConversationId` as provenance; harvest source |
| External CLI transcripts | AI Vault (`src/main/ai-vault/*`, read-only scan) | harvest source |
| Claude availability | `ProviderQuotaObservations` (`src/main/conversation/provider-quota-observations.ts`, in memory) | CONNECT read-only; EXTEND with a change event |
| Admission | `decideDispatchAdmission` (`orchestration/dispatch-admission.ts`) | ADOPT via orchestration |
| Human decisions | orchestration `decision_gates` | CONNECT (human lane) |
| Code review / approvals | Agent Federation reviews + subject-bound approvals | ADOPT for candidate-code promotion |
| Missions / Workstreams / Knowledge / general audit | no owner in Orca | not built here; backlog keeps its own append-only event table because no audit owner exists |
| ChatGPT transport | InfinityOps plugin (`feat/chatgpt-plugin-v1`, Phoenix MCP + OAuth 2.1, FounderOps) | CONNECT via `backlog-infinityops-contract.md` |

**Decision: the Backlog sits above Tasks.** Neither existing Task noun can hold unexecuted,
cross-project, reconciled intent: one is a remote-tracker view, the other a run-scoped dispatch unit in
a DB that is not crash-durable (WAL + synchronous=NORMAL). The Backlog is a new main-process ledger in
its own crash-durable store, under a `config/durability-contracts.jsonc` contract.

## Model (semantic; exact schema is decided by the implementing phase)

- **Item** — accepted intent: kind (smallest useful set derived from use), original text, normalized
  intent, 0..n project refs with mapping evidence, lifecycle state, completion contract by kind,
  executor policy (preferred / fallback / condition), dependencies, priority.
- **Candidate** — discovered intent with a source fingerprint (idempotency key), capture provenance,
  capability level of its adapter, and uncertainty. Actions: accept · merge into item · already done ·
  superseded · dismiss · assign project · leave unassigned.
- **Source link** — many per item; a merge never drops one.
- **Execution link** — orchestration task id · GitHub issue · conversation id · FounderTask id.
- **Evidence** — reconciliation facts with an epistemic class: PROVEN · OBSERVED · INFERRED ·
  HYPOTHESIZED · RETRACTED · UNKNOWN · STALE.
- **Event** — append-only transition log (candidate discovered/accepted/merged, project assigned,
  executor changed, execution requested/started/blocked, result submitted, completed, reopened,
  superseded, dismissed).

Lifecycle is derived from use; at minimum it distinguishes candidate · needs triage · ready · waiting
for preferred executor · preparing · running · review · done · blocked · stale · superseded ·
dismissed · unknown. **Done requires the completion contract of the item's kind** (engineering:
revision + gate evidence; research: artifact; decision: explicit human resolution; manual: explicit
confirmation).

## Sources

| Source | Path | Coverage label |
|---|---|---|
| Manual | Orca capture | full |
| Orca conversations | ConversationStore | full for this profile |
| Claude Code / Codex transcripts | AI Vault | best-effort (vendor file formats) |
| ChatGPT history | **local import of the official account export** (`conversations.json`); no official history API exists (checked 2026-09-29) | bounded by export date |
| ChatGPT live | InfinityOps plugin tools | see platform limits |
| Cursor | none stable | UNSUPPORTED until a stable interface exists |

Harvest is local-first: raw archives never leave the machine; only items the user sends to an external
lane leave, with the minimum packet, after a secret scan.

## Reconciliation

Before a candidate is trusted as pending, check the strongest available evidence: backlog items,
orchestration tasks, commits referencing the item, GitHub issue state, conversations, FounderTask
results, explicit later decisions. Outcomes: still due · partially done · already done · superseded ·
duplicate · blocked · stale · unknown — each with its evidence rows. A model classification is a
proposal and never closes or opens an item alone.

## Executor lanes

| Lane | Route | Constraint |
|---|---|---|
| Human | `decision_gates` / explicit resolution | never auto-executed or reinterpreted |
| Claude (high trust) | orchestration `taskCreate` → admission | gated on `ProviderQuotaObservations` |
| ChatGPT unattended | **Codex CLI signed in with ChatGPT** (official; live-observed 2026-09-20, `auth_mode: chatgpt`, no API key) | preparation artifacts; code only as a candidate in an isolated worktree |
| ChatGPT interactive | InfinityOps FounderTask (`source_kind=orca_backlog`), user invokes `@InfinityOps` | write-back PROVEN on the Owner's Pro/EEA account (2026-09-29 16:57: `submit_founder_result` persisted and rendered on `/dashboard/founder`), contradicting the help-center claim that Pro developer mode is read/fetch only; `capture_intent` is therefore viable on Pro. Interactive only — Codex stays the unattended lane |
| Deterministic | scripts / checks | — |

**Run when Claude is available** reacts to a quota-owner change, never a poll, and re-validates at the
effect: item still pending, not superseded, deps satisfied, project/worktree valid, provider
available, authority valid, admission passes, no other executor completed it. **Execute selected**
submits intents to orchestration with dependencies; it never spawns per item. **Candidate code** from
a lower-trust lane goes: isolated worktree → deterministic gates → Federation review by the Claude
lane → Product Reality where required → eligible for integration.

## Platform facts (2026-09-29, re-verify before relying)

- No documented deep link into a ChatGPT app. `chatgpt.com/?q=` prefills and submits a prompt but is
  **undocumented** (community evidence only) → progressive enhancement with a clipboard fallback.
- A ChatGPT subscription is not a headless API — **except** through Codex, which is an official
  OpenAI surface running on the subscription.
- Account export: Free/Plus/Pro self-service; up to 7 days; link valid 24 h.

## Done-gate (program)

The program is complete only when the prompt-of-record done-gate passes (`.planning/workstreams/ub/
MISSION.md`), in the vocabulary COMPLETE AND PROVEN · COMPLETE FOR AUTONOMOUS SCOPE · PARTIALLY PROVEN ·
BLOCKED BY EXTERNAL AUTHORIZATION · UNVERIFIED · INCONCLUSIVE. Every visible count comes from a real
producer; every phase closes on the strongest affordable real-app rung (Playwright CDP, `$electron`).

## Rollback

New tables/files only; the rail entry is behind a visibility flag; each commit reverts cleanly.
