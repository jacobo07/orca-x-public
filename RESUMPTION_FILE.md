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

Base `4e238194e`. Four commits sealed this wave:

| commit | what |
|---|---|
| `20d3c892c` | the conversation durability contract no longer claims nothing writes a record |
| `8ea218e01` | gate: at most one durable product actor catalog may exist |
| `340fc7ca6` | `PersistedState.agents[]`, minted `AgentId`, succession participation |
| `875dcb060` | optional `agentId` on a conversation, same schema version |

**Coherence anchor:** `node config/scripts/check-durable-actor-catalogs.mjs` must print
`1/1 durable actor catalogs declared`. If it prints 0/1 a roster exists that nobody declared.

### Verified this wave

- **W-B anchor re-run at current head:** `conversations-reachability --project=electron-headless`
  **1 passed, 1.6 m**, `SKIP_BUILD=1` (legitimate — no source commit since `out/` was built).
- fixture-binding 340 specs/715 callbacks; typecheck node+cli+web exit 0; durability 16 contracts.
- Conversation surface 83 passed / 4 skipped. Agent tests 11/11.
- Mutations all CAUGHT, restores SHA-256 verified: gate MAX check, agent succession removed,
  agent blanket-rewrite, agent-binding refusal removed, absent-binding treated as unreadable.

### The measurement that shaped the design

Orca has **three** Project-ish nouns. `Repo` is minted and stable but per-host. `Project` is
**projected from repos on every read** and its id is **rewritten mid-session** (`repo:` → `git:` →
`github:`). `ProjectGroup` is a stable user folder over repos — orthogonal to `Project`, not its
container. See `[[orca-three-project-nouns]]`.

Agents bind to `Project.id` and are remapped inside `rebuildRepoBackedProjectState`, because
`remappedProjectIds` is computed per read and **discarded** — a dependent outside that function
gets one chance and can never catch up. That is also why a conversation carries no project of its
own.

## 3. Active decisions

- Agents live in `PersistedState`, **not** a new store — the only place succession can reach them.
- No schema bump ever for the conversation record; the binding is optional at v1.
- Persistent Agents take the product noun "Agentes"; the existing `agents` rail entry currently
  opens `ActivityPrototypePage` (a runtime feed) and gets the truthful rename.
- No Mission fields, no Councils, no Stop control, no approval decider.

## 4. Next three actions

1. **W-C3 — Agentes surface.** `agents` is already a rail activity gated by `experimentalActivity`
   and already dispatches; the work is a real AgentsPage, a New Agent flow that calls
   `mintAgentId`, and renaming the runtime feed. `mintAgentId` has **no production caller** until
   this lands.
2. **W-C4 — Direct Agent Chat** on the existing `ConversationService` path, setting `agentId`.
3. **W-C5 — real Electron:** create, cold restart, same `agentId`, and **zero provider runtimes**
   counted by identity, not by a flat count.

## 5. Start instruction

Re-prove the worktree, run the coherence anchor, then continue at action 1.

Run tests as `node node_modules\vitest\vitest.mjs run --config config/vitest.config.ts <paths>
--maxWorkers=2` — never `pnpm exec`. Never the full suite: OOM-killed here.
Typecheck as one line: `npm run typecheck *> <log>` then read the log — a PowerShell line that
*begins* with `&` gets mangled by the launcher wrapper.
When driving a mutation, use SINGLE-LINE anchors and assert the anchor matched: a `\n`-joined
anchor matches nothing against this CRLF tree, and that is indistinguishable from a survivor.
