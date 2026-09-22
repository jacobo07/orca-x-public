# RESUMPTION — Orca Cognitive Workspace, W-C (Persistent Agents)

## 1. Identity

Continuing **W-C of the Cognitive Workspace program**. Spec of record:
`docs/orca-cognitive-workspace-spec.md` (tracked, APPROVED) — do not write a second spec.

**Worktree: `C:\Users\User\Apps\orca-cogws-wt`. Branch: `orca-x/cognitive-workspace`.**
A `/clear` has now FOUR times reopened this pane in the main checkout on a different branch.
Re-prove `git worktree list` before mutating anything.

**Thesis:** W-B made a conversation durable and reachable. W-C gives it someone to be *with* — a
durable product Agent that outlives every provider session, pane and repo-identity change.

## 2. Exact state

W-C3 sealed at `ae467a83e` (11 commits inclusive of `d72f3ffdd`; the two-dot range
`d72f3ffdd..ae467a83e` excludes its own base and yields 10 — both describe different ranges).

**W-C4 — Direct Agent Chat — is complete and sealed**, six commits `ae467a83e..1316c62ad`:

| commit | what |
|---|---|
| `d3998c9de` | `createForAgent` — the one producer of `agentId`; the agent owns the project |
| `a5da725bf` | the role reaches the provider as `developerInstructions`, never `baseInstructions` |
| `a9e046612` | the row opens a chat, on the same surface Brainstorming uses |
| `82f49d847` | product reality: talk to an agent, restart, find the same conversation |
| `61b9eff8f` | `check:agent-instruction-layer` + the agent-bound real-provider case |
| `1316c62ad` | typecheck fix only the node project could see |

**Coherence anchors — all four must pass before mutating anything:**

```
node config/scripts/check-durable-actor-catalogs.mjs      # 1/1 durable actor catalogs
node config/scripts/check-agent-identity-authority.mjs    # agent-operations.ts is the only minter
node config/scripts/check-recurring-work-inventory.mjs    # debt=0
node config/scripts/check-agent-instruction-layer.mjs     # no production use of baseInstructions
```

### Verified this wave

- **Product reality, real Electron, two launches, passed twice on final code** (`1 passed`, ~1.3m):
  create an agent, open its row, send, restart, and the agent's row reopens the SAME conversation
  by id with the message still there. Browsing an agent mints nothing.
- **Driven red at the product boundary**: a build whose agent scope called the unbound `create` —
  the agent's name in the header, Brainstorming underneath — failed at the agent-scoped row count.
  The first attempt died in `session.launch()` and was recorded HARNESS_FAILED, not caught.
- **14 unit mutations, 14 caught**, every restore SHA-256 verified.
- **W-C3's `agents-reachability` proof re-passed** on the new row markup.
- Typechecks node/cli/web exit 0; 157 unit tests passed, 5 skipped.

## 3. Active decisions (do not relitigate)

- **`createForAgent` takes no project.** The agent owns it; `agentFor()` derives it per read through
  the roster, so Project id succession needs no remap here. Mismatch is unrepresentable, not
  validated. `ConversationRecord.projectId` stays for Brainstorming and still has **no production
  producer** — named debt, not a bug to "fix" by inventing one.
- **One chat stack.** `ConversationsPage` serves Brainstorming and Agent Chat; the scope decides
  which rows list, which create runs, and the header. Never build an agent-shaped copy.
- **The scope is never persisted.** `activeView` is restored at startup; a restored scope would
  re-enter an agent chat nobody asked for.
- **`developerInstructions` only.** `baseInstructions` replaces the provider's own and is gated.
- An agent-bound turn whose agent cannot be resolved refuses (`agent-unavailable`) before the user's
  message is committed. It never degrades to Brainstorming.

## 4. Open, named, not hidden

- **The real-provider leg has NEVER RUN.** `conversation-reality.test.ts` holds an agent-bound case
  (`ORCA_CODEX_REALITY=1`) with a Brainstorming control proving role influence is attributable. It
  stops at its precondition: `codex login status` says **Not logged in**, and no `auth.json` exists
  in `~/.codex` or `%APPDATA%\orca\codex-runtime-home\home`. The Owner must `codex login` first.
  Codex's acceptance of `developerInstructions` is known **from its own generated schema only**.
- **What the agent receives**: name, role, thread history, the user's message, `cwd`. **No project
  files, no repo context, no memory.** Do not describe Agent Chat as project-aware.
- **CI altitude is CI-WIRED, not runner-observed** — the new gate is in `pr.yml` beside the other
  two, and this fork's PR runs still show `runner_id=0` with no step started.
- **Debt**: `tests/e2e/conversations-reachability.spec.ts` still has a bare
  `finally { await session.dispose() }` — the EPERM-replaces-verdict shape `caf007c4b` fixed next
  door. One line, not fixed here to keep the wave's diff honest.
- Multi-window is still not live-synced; `worktreeMeta.projectId` remains UNVERIFIED.

## 5. Next three actions

1. **Run the real-provider gate** once the Owner has signed Codex in:
   `ORCA_CODEX_REALITY=1 vitest run --config config/vitest.config.ts
   src/main/conversation/conversation-reality.test.ts -t 'agent-bound'`. It spends three real turns.
2. **W-C5 candidate — Project Context Router.** The measured slot is
   `turn/start.additionalContext` (keyed fragments). This is the largest honesty gap in the product:
   an agent belongs to a project and knows nothing about it.
3. Fix the `conversations-reachability` cleanup line while touching that file next.

## 6. Start instruction

Read §2, run the four coherence anchors, confirm `git worktree list` puts you in
`C:\Users\User\Apps\orca-cogws-wt` on `orca-x/cognitive-workspace`, then begin at §5.
Do not rebuild anything in §2 — it is sealed and proven in a real Electron run.
