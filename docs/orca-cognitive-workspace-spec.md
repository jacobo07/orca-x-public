# Orca Cognitive Workspace — Spec of Record

Status: **APPROVED (Owner, 2026-09-20) — W0 in progress.** Six Owner decisions settled; see §9.
Mode: EXECUTION (ULTRA-PLAN closed). Scope reduced ~65% by Reality Scan.
Date: 2026-09-20. Branch at scan time: `orca-x/w0-durability-repros` @ `6e74986a7`, 34 dirty paths,
7 worktrees live. **Program worktree: `C:\Users\User\Apps\orca-cogws-wt`, branch
`orca-x/cognitive-workspace`, base `2f919f50b` (main).** SDD-OS tier: **T3**.
`covers: [cognitive-workspace, brainstorming, agents, deliberation, provider-gateway,
conversation-identity]`

> **This file is tracked.** `docs/**` is ignored by design; `.gitignore` carries an explicit
> allow-list for durable docs and this spec is on it. Before this entry the spec of record lived
> only as an ignored local file — a constitutional record with no durable owner.

---

## 1. The thesis, in one paragraph

Orca X already owns a ChatGPT-class conversation renderer, a provider-neutral message contract with
four transcript decoders, a 17-agent cross-host conversation index, an orchestration database with
tasks/dispatch/inbox/authority, a canonical multi-host project identity, and a capability-negotiated
remote wire. It does **not** own a conversation that can exist without a live terminal pane, and it
has no way to run an agent turn without a PTY. The mission is therefore not to build a chat product.
It is to **lift the existing chat off the pane and give it a non-PTY engine.** Everything the prompt
asks for composes from that one move plus existing owners.

---

## 2. Reality Scan — what already exists (evidence)

| Capability the brief asks for | Verdict | Owner (evidence) |
|---|---|---|
| Chat UI (non-terminal) | **EXISTS** | `src/renderer/src/components/native-chat/` — 25 components incl. `NativeChatView`, `MessageList`, `Composer`, `ToolRun`, `DiffView`, `ApprovalCard`, `QuestionCard`, `InteractiveCard` |
| Provider-neutral event contract | **EXISTS** | `src/shared/native-chat-types.ts` — `NativeChatBlock = text \| tool-call \| tool-result \| image-ref`; roles `user\|assistant\|tool\|reasoning\|system`; `NativeChatTurnLifecycle = working\|completed\|interrupted` |
| Source precedence / dedup | **EXISTS** | same file, `transcript:3 > hook:2 > scrape:1` |
| Transcript decoders | **EXISTS** | `src/main/native-chat/transcript-line-decoders-{claude,codex,grok,omp}.ts` |
| Incremental streaming transport | **EXISTS** | `src/preload/api/native-chat-api.ts` — frames `snapshot \| replacement \| appended`; mirrored to `nativeChat.subscribe` in `src/main/runtime/rpc/methods/native-chat.ts` for web/remote |
| Streaming assistant bubble | **EXISTS** | `src/shared/native-chat-streaming.ts` |
| Markdown / KaTeX / Mermaid / virtualization | **EXISTS** | `react-markdown@10`, `remark-gfm/math/breaks/frontmatter`, `rehype-highlight/katex/raw/sanitize/slug`, `katex`, `mermaid`, `@tanstack/react-virtual` |
| Conversation history index | **EXISTS** | `src/main/ai-vault/` — 176 files, 17 agents, local + SSH + runtime; `aiVault:listSessions`, `prepareSessionResume`, `getFirstUserPrompt`, `deleteSession` |
| Logical multi-host Project identity | **EXISTS (first-class entity)** | `src/shared/project-types.ts:16` — `Project { id, displayName, badgeColor, providerIdentity, gitRemoteIdentity, sourceRepoIds: string[] }`, fanned to hosts by `ProjectHostSetup{projectId, hostId, repoId, path, setupState, worktreeBasePath}` (`:47`). Carried into runs by `WorkspaceRunContext` (`src/shared/task-source-context.ts:40`). Persisted at `PersistedState.projects/.projectHostSetups` |
| Workspace identity (git **and** folder) | **EXISTS** | `src/shared/folder-workspace-types.ts:11` — `WorkspaceKey = \`worktree:${string}\` \| \`folder:${string}\`` |
| Decision owner | **EXISTS** | `decision_gates` + `runs.objective` tables, `src/main/runtime/orchestration/db.ts:353-688` |
| Agent-team RPC family | **EXISTS** | `agentTeams` — one of 29 families in `src/main/runtime/runtime-rpc.ts` |
| Client capability negotiation | **EXISTS** | `src/shared/protocol-version.ts` — `RUNTIME_PROTOCOL_VERSION = 3`, `RUNTIME_CAPABILITIES` (~45 named `*.vN`), bound per-socket via `RpcContext.clientCapabilities` |
| Mission / task ledger | **EXISTS** | `orchestration.taskCreate/taskList/taskUpdate`, SQLite at `userData/orchestration.db`, tasks carry `spec`, `deps` (DAG), `parentId`, status, result |
| Agent-to-agent messaging | **EXISTS** | `orchestration.send/reply/inbox/ask` + federation relay |
| Execution authority | **EXISTS** | `getOrchestrationDispatchAuthority(handle)` → `{paneKey, processIncarnation}`; `orchestration.dispatch` |
| Scheduled agent work bound to a project | **EXISTS** | `Automation { name, prompt, agentId, runContext, workspaceMode, rrule }` |
| Live multi-agent roster | **EXISTS** | `src/shared/claude-subagent-roster.ts` (named teammates, `a<name>-<hex>`, TeammateIdle, resumable), `codex-subagent-roster.ts` |
| Surface registration | **EXISTS** | `src/renderer/src/components/activity-rail/workspace-activity-items.ts` (4-file registration) |
| Generic Codex JSON-RPC transport | **EXISTS (unused for chat)** | `src/main/codex/codex-app-server-session.ts` — `request(method, params)` / `notify()`, initialize handshake, method-not-found taxonomy, oversize + deadline guards |

### The five real gaps

1. **Conversation identity is a pane leaf.** `native-chat-leaf-routing.ts` types the whole surface as
   a *view mode* of a terminal split leaf (`paneKey = ${tabId}:${leafId}`); removing the leaf returns
   the tab to terminal mode. `NativeChatSessionGate` renders `not-agent` with no pane. No PTY → no
   conversation.
2. **No non-PTY turn engine.** `NativeChatComposer` writes keystrokes into the PTY
   (`sendNativeChatMessage(settings, ptyId, text)`, `submitNativeChatPrompt`, ESC to interrupt).
3. **No Provider Gateway.** The ten `src/main/{claude,codex,amp,…}` directories are independent
   integrations. `src/main/providers/` is a *host* abstraction (pty/fs/git), a different axis.
4. **No Orca-owned agent persona.** Only provider-internal subagent observation.
5. **No deliberation protocol, no context router.** Orchestration has messaging, `decision_gates`
   and an `agentTeams` RPC family, but no bounded rounds, information-gain gate, synthesis, or
   dissent preservation.
6. **No project knowledge store.** Confirmed ABSENT — searched `src/shared`, `src/main/ai-vault`,
   `src/main/memory` for `embedding|vectorStore|knowledgeBase|projectBrain`; only unrelated hits.
   `src/main/memory` is process-RSS metrics. Top-level `vault/` is repo tooling, not shipped.

**The independent ownership scan's own verdict:** *"The only two greenfield gaps are agent
persona/roster and project knowledge store."* Both are named above; the second is explicitly out of
scope for this program.

### Where a new identity must hang (binding rules)

`Project` (`shared/project-types.ts`) × `ProjectHostSetup` × `WorkspaceKey`
(`shared/folder-workspace-types.ts`) → persist through `PersistedState`
(`shared/persisted-state-types.ts`) written by the single writer `Store.buildStateToSave()`
(`main/persistence/loading-store/store.ts:1766`) to `userData/profiles/<profileId>/orca-data.json` →
expose as a new RPC family under `src/main/runtime/rpc/methods/` guarded by a new capability
constant in `shared/protocol-version.ts`. Provider-session identity reuses
`AgentProviderSessionMetadata { key: 'session_id'|'conversation_id', id, transcriptPath? }`
(`shared/agent-session-resume.ts:24`), whose 12-member `RESUMABLE_TUI_AGENTS` set already answers
"which agents can be resumed at all".

### Duplicate-to-advantage: the reference sidebar maps onto real owners

`Nuevo chat` → new Conversation · `Agentes` → orchestration + personas · `Biblioteca` → Artifacts
surface · `Programadas` → **Automations** (rrule, real) · `Complementos` → Plugins + Skills ·
`Proyectos` → `WorkspaceRunContext.projectId` · `Chats` → AI Vault sessions. Every reference entry
has a real Orca consumer. **No placeholder is required to build the reference sidebar.**

---

## 3. Donor audit — PlantGPT

- Licence **AGPL-3.0**; Orca X is **MIT** (`LICENSE`, Lovecast Inc.). **Decisive: no PlantGPT code,
  asset or file may enter this repository.** Doing so would relicense Orca.
- 3 commits total, 6 stars, Tauri v2 + React + Vite + Ollama. A clone of ecogpt.com, itself a
  ChatGPT clone. Not a maintained donor, and the shell is Tauri, not Electron.
- Classification: **NOT USEFUL as code donor.** Its `UI-SPEC.md` is a set of *measurements*
  (sidebar 260px, chat column 777px, composer max-width 736px / height 57px / radius 28px, user
  bubble radius 24px right-aligned, base text 16px/26.4px, nav rows 243×36px radius 8px). Facts are
  usable as a reference matrix; they are not a substitute for the Owner's own video.

---

## 4. Target architecture

### 4.1 The one new identity

`OrcaConversation` — Orca-owned, outlives every provider/process/pane incarnation.

```
conversationId        Orca-minted, stable forever
project               WorkspaceRunContext | null   (null = global conversation)
agent                 TuiAgent
participant           AgentProfileId | null        (null = plain Brainstorming)
providerThread        { kind, id, transcriptPath } | null
title, createdAt, updatedAt, lastTurnAt, archived
realityBinding        { branch, head, dirty, capturedAt } | null
```

**Law:** `ConversationId ≠ ProviderThreadId ≠ AgentSessionId ≠ ProcessIncarnation ≠ PaneKey ≠ Host.`
A conversation may rebind to a new provider thread; it never changes id.

### 4.2 Provider Gateway

`AgentTurnEngine` with `capabilities()`, `startThread()`, `resumeThread(id)`,
`sendTurn(input) → AsyncIterable<NativeChatEvent>`, `interrupt()`. Two drivers:

- **`pty`** — wraps today's behaviour exactly. No regression, covers every agent.
- **`codex-app-server`** — the real non-terminal path. Every method below is **schema-observed on
  this host** (W0, §9): `thread/start`, `thread/resume`, `turn/start`, `turn/steer`,
  `turn/interrupt`; notifications `item/started`, `item/agentMessage/delta`,
  `item/commandExecution/outputDelta`, `item/reasoning/summaryTextDelta`, `item/plan/delta`,
  `item/completed`, `turn/completed`; auth `account/read`, `account/login/start`, `account/logout`.

  **Correction (W0).** Approvals are **not notifications.** `item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `applyPatchApproval`,
  `execCommandApproval` and `item/tool/requestUserInput` live in `ServerRequest`, not
  `ServerNotification` — the server issues a **request to the client and waits for a reply**. A
  notification sink is therefore not sufficient: the driver needs a bidirectional JSON-RPC peer that
  can *answer*. Orca's existing session helper has no server-request path at all, so approvals are
  structurally unreachable on it today rather than merely unhandled.

Mapping to the existing contract is near 1:1: `agentMessage/delta` → streaming text block;
`item/completed` → `tool-call`/`tool-result`; `turn/*` → `NativeChatTurnLifecycle`;
`requestApproval` → the existing `NativeChatApprovalCard`.

Three measured deltas in `codex-app-server-session.ts` (W0, §9), all bounded:

1. **Unsolicited lines are discarded.** The stdout reader is
   `if (typeof message.id === 'number' && pending.has(message.id)) { … }` with **no `else`** (l.183).
   Every server notification *and* every server request falls through and is dropped.
2. **A whole-session deadline SIGKILLs the child** (l.202) and teardown closes stdin and reaps
   (l.301). Short-lived by construction; a conversation is not.
3. **No server-request path**, per the approvals correction above.

What must **not** be rebuilt: the JSONL framing, multibyte-safe stream decode, oversized-line guard,
`CODEX_HOME` env overlay with `envToDelete`, Windows `taskkill /t /f` process-tree reap, EPIPE
handling, and the `CodexAppServerUnsupportedError` method-not-found taxonomy. That is hard-won and is
exactly what a long-lived driver needs — **generalize this module, do not fork it.**

**Transport finding (W0, not in the approved plan).** `codex app-server` is not only a spawnable
stdio child. It exposes `daemon` (a **shared local app-server daemon**), `proxy` ("proxy stdio bytes
to the running app-server control socket"), and `--listen` accepting `stdio://`, `unix://` and
`ws://IP:PORT`. `codex agents` browses sessions on that shared daemon, and `codex remote-control`
(`start`/`stop`/`pair`) manages it with remote control enabled. Attaching to a shared daemon is a
materially better fit for durable conversation identity than Orca owning a per-conversation child,
and `remoteControl/*` is Codex-native ground for W3/W8 mobile parity. **This changes a W2 design
input and must be decided in W2 on measured evidence, not adopted by default** — a shared daemon is
also shared *state*, with its own lifetime, versioning and multi-client contention.

**Honest failure semantics:** `account/read` returning unauthenticated is an error state on the
conversation, never a message. **401 is not a conversation.** `CodexAppServerUnsupportedError`
(method-not-found) degrades to the `pty` driver and says so.

### 4.3 What is deliberately NOT built

No second Project system · no second Knowledge Vault · no second Mission engine · no second runtime
fabric · no custom Markdown engine · no second agent memory silo · no new networking · no "Project
Brain" persisted derived store in this program (no owner exists; a Context Router resolving from
*existing* authorities is in scope, a new derived knowledge plane is a separate program).

---

## 5. Waves

Each wave: owner extended · contract · RED proof · gate · exit.

**W0 — Falsify the premises (no product code).** Probe the installed `codex` binary for the
app-server conversation methods; probe Claude's headless mode; record both. Capture the reference
video's states. Exit: a recorded probe transcript, or a named blocker. *This wave can fail the whole
plan; it runs first for that reason.*

**W1 — Conversation identity and durability.** New `OrcaConversation` store + a
`config/durability-contracts.jsonc` entry at **crash-durable** (it is the only copy of the binding;
a durable pointer needs a durable referent). RED: open a conversation whose pane is gone — today
impossible. Gate: restart the app, reopen the same conversation with content.

**W2 — Provider Gateway + Codex non-PTY turn.** Gate: a real Codex turn streams into NativeChat with
no terminal anywhere, persists, and re-renders after restart. Mutations: sever the driver → red;
force `account/read` unauthenticated → error state, not a message.

**W3 — Brainstorming surface.** New `TopLevelView`, rail entry, project-grouped conversation list
sourced from AI Vault + Orca conversations. Lift `NativeChatView` off `paneKey`. Gate: new chat →
ask → stream → restart → reopen, on desktop **and** on the paired mobile client over the existing
runtime RPC with capability negotiation.

**W4 — Project binding + Context Router.** Bind to `WorkspaceRunContext`; attach reality explicitly
with freshness and provenance per turn. Gate: a fresh chat in a project answers a state question
citing real resolved sources; stale evidence is labelled stale, never silently used.

**W5 — Agent personas.** `AgentProfile { id, role, projectMemberships, providerBinding, authority }`,
read-only authority by default. Gate: same persona, two devices, two provider threads, one identity.

**W6 — Deliberation.** Bounded rounds over orchestration messaging; information-gain gate; synthesis
that preserves unresolved dissent. Gate: 2+ agents disagree, dissent survives synthesis, budget
enforced, recursive delegation refused.

**W7 — Mission and Workspace bridges.** Decision → `orchestration.taskCreate` or `Automation`.
Send to Workspace → existing launch/ensure authority + live-session collision guard + authority
revalidated at effect time. Gate: a real consumer receives it; wrong workspace and stale reality are
refused with distinct reasons.

**W8 — Visual acceptance, a11y, parity.** Reference matrix; `config/variant-parity.jsonc` entry; five
locale catalogues; `pnpm check:recurring-work` classification for any new timer.

**Minimum Durable Architecture = W0–W4.** W5–W8 are the second program.

---

## 6. Falsification experiment

Project-bound conversation on client A → real streaming Codex turn with no terminal → persist →
restart / move to another client → same conversation continues → escalate to a ≥2-agent deliberation
→ agents disagree → dissent preserved → synthesis → Mission created in the real orchestration DB →
sent to a real workspace consumer → effect observed or correctly refused at the authority boundary.
Inject: provider interruption, stale reality, app restart, network loss, one agent failure.
Any stage that is hardcoded, mocked, disconnected, or loses identity = **architecture not proven.**

---

## 7. Risks

1. **W0 falsifies the Codex path** (installed binary too old / methods absent). Mitigation: the `pty`
   driver keeps every agent working; Brainstorming ships pane-free but PTY-backed. Named, not hidden.
2. **Concurrent writers.** 7 worktrees; another pane owns working-set, sleep-authorization and
   agent-session presence files on this branch. This program takes its **own worktree**.
3. **Remote wire compatibility.** Every client/host exchange follows
   `docs/reference/remote-wire-compatibility.md`; new stream opcodes are capability-negotiated
   because decoders drop unknown opcodes silently.
4. **Privacy.** Project-aware chat sends repository context to a third party. Secret redaction and an
   explicit context-attachment policy are gates, not afterthoughts.
5. **Host fragility.** Measured this session: Bash `ls`/`grep`/`cat` hang; a `Grep` over all of `src`
   times out at 20s; `npx` is broken; `git` is absent from PowerShell's non-interactive PATH; the
   full vitest suite is OOM-killed. All runs are scoped and captured to files.

---

## 8. Known-absent inputs

- **The reference video `Screen_Recording_20260920_162714_ChatGPT.mp4` is not on this host.**
  **Re-measured in W0 with a second, independently-built instrument** (full recursion — no depth
  cap — over `Downloads`, `Videos`, `Desktop`, `Pictures` and `OneDrive`; exact-name hunt, plus
  `Screen_Recording*`, `*ChatGPT*` and a 7-day media sweep). Exit 0, completion marker present.
  Result: exact name **absent**; 22 `Screen_Recording_*` files and 10 recent videos *were* found, so
  the instrument demonstrably sees this class and the absence is a measurement, not a blind spot.
  Newest screen recording anywhere: `Screen_Recording_20260918_140526_One UI Home.mp4`. The only
  2026-09-20 media on the host is an unrelated 79 KB `DisneyLanders - Lucasfilm intro.mp4`. The only
  `*ChatGPT*` media are four 2026-03-09 Wii map screenshots in another project — not UI references.
  Two differently-built instruments agree: the file was never transferred from the phone.
  **Consequence (Owner Decision 1 fallback): W0–W7 proceed; W8 visual fidelity is BLOCKED, and is
  reported as BLOCKED rather than proven.** If the file arrives mid-run it is consumed without
  asking.
- Codex app-server conversation methods were **documented, not observed**. W0 moved them to
  **schema-observed on this host** — generated from the installed binary, not from upstream docs.
  Ladder: requested → documented → **schema-observed** → fixture-observed → live-observed. The
  remaining rung is a real `thread/start` + `turn/start` round trip against an authenticated
  account, which W2 owns. Method *presence* is proven; method *behaviour* is not.
- `docs/plans/2026-06-17-001-feat-native-chat-view-plan.md`, cited in `native-chat-types.ts`, does
  not exist in this tree — a documented artifact with no referent.
- **AGENTS.md links two untracked reference docs.** `docs/reference/terminal-preview-observers.md`
  and `docs/reference/resource-elasticity-fabric.md` are linked from tracked `AGENTS.md` (which is
  injected into every agent's context) but are **not** on the `.gitignore` allow-list, so they do
  not exist in a fresh clone or in any new worktree. Pre-existing, outside this program's scope,
  recorded here because it is the same defect class as the spec's own missing durable owner.

---

## 9. W0 evidence — measured 2026-09-20

**Owner decisions settled** (this run): 1 video required but absent → visual gate BLOCKED, rest
proceeds · 2 full W0–W8 scope · 3 **Orca-owned durable conversation state**, provider transcripts are
evidence not authority · 4 reference experience wins information architecture, Orca wins identity and
security · 5 new persona surface takes the name *Agentes*, the existing feed becomes *Actividad* ·
6 Codex default provider, auto-context inside an authorized Project.

### Reproduce the protocol evidence

```
codex app-server generate-json-schema --experimental --out <DIR>
codex app-server generate-ts          --experimental --out <DIR>
```

Binary measured: `C:\Users\User\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe`,
`codex-cli 0.153.4`. Exit 0. 47 schema files plus `v1/` and `v2/` bundles
(`codex_app_server_protocol.v2.schemas.json`, 706 KB — the protocol is versioned).

The bundle is **regenerable from the installed binary and is deliberately not committed**; the
command above is the durable artifact. Counts: **155** client requests, **81** server notifications,
**11** server requests, **1** client notification (`initialized`).

### What the product contract needs, and what was found

| Contract need | Measured | Where |
|---|---|---|
| create / resume / fork a conversation | yes | `thread/start`, `thread/resume`, `thread/fork` |
| start / continue / cancel a turn | yes | `turn/start`, `turn/steer`, `turn/interrupt` |
| streamed assistant text | yes | `item/agentMessage/delta` |
| tool + command + plan deltas | yes | `item/commandExecution/outputDelta`, `item/fileChange/outputDelta`, `item/plan/delta` |
| lifecycle | yes | `item/started`, `item/completed`, `turn/started`, `turn/completed`, `thread/status/changed` |
| approvals | yes — **as server→client requests** | `item/{commandExecution,fileChange,permissions}/requestApproval`, `item/tool/requestUserInput` |
| auth / 401 as an error state | yes | `account/read`, `account/rateLimits/read`, `modelProvider/authRecoveryStarted` |
| errors | yes | `error` notification, `JSONRPCError` |
| history / search | yes | `thread/list`, `thread/items/list`, `thread/turns/list`, `thread/search` |
| remote / mobile pairing | yes | `remoteControl/enable`, `remoteControl/pairing/start`, `remoteControl/client/list` |

**W0 verdict on the primary risk: RETIRED.** Risk 1 in §7 ("W0 falsifies the Codex path") did not
occur. No fallback to a PTY-backed Brainstorming is required on capability grounds.

**Scope note — Codex owns a `project/*` family** (`project/create|list|read|update|delete|import|move`
plus a `thread/project/updated` notification). Per §4.3 and Decision 3 this is **provenance, not
authority**: Orca's `Project` remains the single project identity. Recorded so a future reader does
not mistake its existence for permission to build a second project system.

### Reasoning content

`item/reasoning/textDelta` and `item/reasoning/summaryTextDelta` exist and stream. Decision 3 is
explicit that private chain-of-thought is **never persisted merely because a provider emits it**.
Reasoning may render transiently; it does not enter the durable store. This is a W1 store-schema
constraint, not a W2 rendering preference.

### Live observation — the ladder's last rung, reached

A real turn was executed against the installed binary. Sandbox pinned `read-only` (enum measured:
`read-only | workspace-write | danger-full-access`), throwaway `cwd` under `%TEMP%`, a prompt needing
no tools, and any server-initiated approval request auto-denied.

| gate | result |
|---|---|
| `V-W0-THREAD-START` | PASS — `threadId 01a0bff4-a9bc-7833-bd9f-c74a8aea4608` |
| `V-W0-TURN-STREAMED` | PASS — **5** `item/agentMessage/delta` (genuine incremental streaming) |
| `V-W0-TURN-COMPLETED` | PASS — `turn/completed`, no `error` |
| `V-W0-SENTINEL` | PASS — assistant text exactly `ORCA_W0_OK` |
| `V-W0-THREAD-PERSISTED` | PASS — a **new** app-server process lists the thread |
| `V-W0-THREAD-RESUME` | PASS — `thread/resume` accepted |
| `V-W0-CONTINUITY` | PASS — after provider process death, the model recalled `ORCA_W0_OK` |
| `V-W0-CLAUDE-HEADLESS` | PASS — `claude -p --output-format stream-json`, 40 KB NDJSON, sentinel returned |

26 notifications in one turn, including `thread/started`, `turn/started`, `item/started`,
`item/completed`, `thread/status/changed`, `thread/tokenUsage/updated`, `account/rateLimits/updated`
and `hook/started`/`hook/completed`.

**Authentication measured, not assumed:** ChatGPT account, `planType: plus`, `requiresOpenaiAuth:
true`, identical under **both** the Orca-managed `CODEX_HOME`
(`…\Roaming\orca\codex-runtime-home\home`) and the real `~/.codex`. Rate limits at probe time:
primary 3 % of a 300-min window, secondary 0 %. `credits.hasCredits` is `false` with balance `0` —
plan limits carry the turns, not credits.

**Provider continuity does NOT discharge W1.** It is keyed to a Codex `threadId`, lives in a
`CODEX_HOME` that Orca manages and can rotate, and disappears under provider rotation. Decision 3
therefore stands unchanged: Orca owns the user-visible conversation; the Codex thread is provenance
and a continuation aid. Codex's own `thread/list` row is far richer than "a transcript file" — it
carries `projectId`, `agentNickname`, `agentRole`, `name`, `gitInfo`, `forkedFromId`,
`parentThreadId`, `status`, `cwd`, `cliVersion`. **W1 must state the boundary explicitly so a future
reader does not mistake that richness for authority.**

**Two wire facts the driver must honour:**

- **`params` is mandatory, even when empty.** `account/read` with no `params` returns
  `-32600 Invalid request: missing field 'params'`. Orca's `requestRpc` omits `params` when
  `undefined` (l.241), so **it structurally cannot call any no-argument method.** Send `{}`.
- **Unsolicited traffic starts immediately.** `remoteControl/status/changed` arrived during the
  handshake itself, before any product request — live confirmation that the l.183 drop is reached in
  practice, not only in theory.

**Gateway must not overfit either provider.** Claude's headless path is non-PTY and resumable
(`-p`, `--output-format stream-json`, `--input-format stream-json`, `--resume <session-id>`) but is
**process-per-invocation NDJSON**, not a long-lived bidirectional peer, and it has no server→client
request channel. It also emitted **one terminal `assistant` event** where Codex streamed five deltas.
So `AgentTurnEngine` may assume neither a persistent socket nor delta-granular output.

### Still open after W0

- **The approval path is unexercised.** 0 server requests arrived, because a read-only prompt needs
  no tools. Approval handling is proven *necessary* (the methods are in `ServerRequest`) and is **not
  proven working**. W2 owns driving it with a prompt that actually requests a command.
- **Daemon vs spawned child undecided** — see the transport finding in §4.2.
- **No Orca code has been changed yet.** Every result above came from standalone probes, so nothing
  here is evidence about Orca's own runtime.
