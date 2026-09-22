# RESUMPTION — Orca Cognitive Workspace, W-C (Persistent Agents)

## 1. Identity

Continuing **W-C of the Cognitive Workspace program**. Spec of record:
`docs/orca-cognitive-workspace-spec.md` (tracked, APPROVED) — do not write a second spec.

**Worktree: `C:\Users\User\Apps\orca-cogws-wt`. Branch: `orca-x/cognitive-workspace`.**
A `/clear` has THREE times reopened this pane in the main checkout on a different branch.
Re-prove `git worktree list` before mutating anything.

**Thesis:** W-B made a conversation durable and reachable. W-C gives it someone to be *with* — a
durable product Agent that outlives every provider session, pane and repo-identity change.

## 2. Exact state

W-C0/1/2 base `354f40617`. **W-C3 is complete and sealed**, eight commits:

| commit | what |
|---|---|
| `d72f3ffdd` | RED + characterization: where the Agents noun pointed, and who may mint an id |
| `644f76daa` | the runtime feed renamed to Activity — no migration, the route id was already right |
| `85216ab7a` | the durable roster becomes readable (`agents:list`) |
| `87cb04931` | Agents rail entry + `'agents'` TopLevelView + page, opt-in |
| `079bb9a8a` | `createAgent` — the first production caller of `mintAgentId`, flushed before it resolves |
| `dd00f6ae2` | New agent dialog + project-grouped directory |
| `d965e48fe` | both actor gates wired into `pr.yml` (CI-WIRED, **not** runner-observed) |
| `ff06c3022` | product reality: create → restart → same `AgentId`, real Electron, **passed** |

**Coherence anchors — all three must pass before mutating anything:**

```
node config/scripts/check-durable-actor-catalogs.mjs     # 1/1 durable actor catalogs declared
node config/scripts/check-agent-identity-authority.mjs    # agent-operations.ts is the only minter
node config/scripts/check-recurring-work-inventory.mjs    # debt=0
```

If the second prints "no production caller mints an AgentId", the creation owner has been reverted.

### Verified this wave

- **Product reality, real Electron, two launches:** `1 passed (1.8m)`. Create through the real
  dialog, close the app, relaunch the same profile, and the row returns **by `data-agent-id`**, not
  by position or name. Exactly one row.
- **`mintAgentId` has exactly one production caller**, in main, enforced by a gate that swept 13,698
  tracked files and was RED for three commits before the owner landed.
- **Creation is durable before it resolves.** `flushDurableStateOrThrowAsync` is awaited; a failed
  flush rolls the record back by id and returns `not-persisted`.
- **Project ownership is re-resolved at effect time**, not trusted from the form — Project ids are
  derived and promote `repo:` → `git:` → `github:` mid-session.
- **Zero recurring work added:** `debt=0`, and the page holds two one-shot `useEffect`s, no interval,
  watcher, worker or per-row subscription. An agent existing costs nothing.
- **No migration was needed for the rename**: `TopLevelView` was already `'activity'`, the rail id is
  persisted nowhere, and no e2e spec referenced it.

## 3. Active decisions (do not relitigate)

- **Agent rows are NOT clickable.** An Agent owns a `role` and nothing compiles it into a turn, so
  opening one would be a Brainstorming chat wearing a label. They become buttons in the wave that
  gives them a destination. This is the W-C3/W-C4 split, decided on product completeness.
- **`showAgentsButton` is its own opt-in key**, not `experimentalActivity`. Two surfaces, two
  meanings, two switches.
- The noun's translate key `...9c95e1ce91` ("Agentes", "에이전트", "智能体") **moved with the noun** to
  the persistent surface. The runtime feed got a new key, `activity.railLabel`.
- Agents sits third in the rail, beside Chats. **Nothing else moved** — reordering the IA is its own
  decision.

## 4. Open, named, not hidden

- **`ConversationRecord.agentId` has ZERO producers.** W-C2 added the type and a parser refusal;
  nothing writes it and `conversations.create` takes no agent. Any claim that the Agent↔Conversation
  relation is usable today is false.
- **`ConversationRecord.projectId` still exists** alongside `agentId`, so an agent/conversation
  project mismatch is *representable*, contrary to what W-C2's commit message asserts. W-C4 decides
  what `projectId` holds for an agent-bound chat.
- **CI altitude is CI-WIRED, not runner-observed.** The most recent `PR Checks` run on this fork
  (`35656031368`, 2026-09-21) shows all 30 jobs at `runner_id=0`, 2–7s, no step started. The local
  gate is the real enforcement.
- **`activity.railLabel` has no catalogue entry**, so non-English builds render "Activity" in
  English — the same state `artifacts` and `skills` already ship in.
- **Multi-window is not live-synced.** Main owns the roster so identity stays canonical, but a second
  window will not see a new agent until it re-reads.
- `worktreeMeta.projectId` remains **UNVERIFIED**. W-C3 never depended on it.

## 5. Next three actions

1. **W-C4, Direct Agent Chat** — the first wave that gives a row somewhere to go. It needs
   `conversations.create` to accept an `agentId` (it does not today) and a decision on what a
   persona compiles into, which is the thing that makes an agent-bound chat differ from Brainstorming.
2. Re-point the row as a button in W-C4's first commit, so the inert state never outlives its reason.
3. Decide `ConversationRecord.projectId` for agent-bound chats before anything writes `agentId`.

## 6. Start instruction

Read §2, run the three coherence anchors, confirm `git worktree list` puts you in
`C:\Users\User\Apps\orca-cogws-wt` on `orca-x/cognitive-workspace`, then begin W-C4 at §5.1.
Do not rebuild anything in §2 — it is sealed and proven in a real Electron run.
