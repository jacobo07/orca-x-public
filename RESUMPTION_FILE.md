# RESUMPTION — Orca Cognitive Workspace, W-C (Persistent Agents)

## 1. Identity

Continuing **W-C of the Cognitive Workspace program**. Spec of record:
`docs/orca-cognitive-workspace-spec.md` (tracked, APPROVED) — do not write a second spec.

**Worktree: `C:\Users\User\Apps\orca-cogws-wt`. Branch: `orca-x/cognitive-workspace`.**
A `/clear` has now **FIVE** times reopened this pane in the main checkout on a different branch —
the W-C5 session opened on `orca-x/w0-durability-repros` in the Desktop checkout and had to
relocate before touching anything. Re-prove `git worktree list` before mutating.

**Thesis:** W-B made a conversation durable and reachable. W-C gives it someone to be *with* — a
durable product Agent that outlives every provider session, pane and repo-identity change.

## 2. Exact state

W-C3 sealed at `ae467a83e`. **W-C4 — Direct Agent Chat — sealed** `ae467a83e..1316c62ad`
(+ `3bf6e3724` resumption).

**W-C5 — the agent's turn runs in its project — is complete and sealed**, nine commits
`3bf6e3724..94973071d`:

| commit | what |
|---|---|
| `5e657c31c` | characterize: an agent's turn runs in Orca's own directory |
| `e5e9e21f8` | `resolveAgentProjectLocation` — agent's project → a local ready path |
| `32cef1fe2` | the fix, inverting the characterization in place; `process.cwd()` unreachable |
| `fa9c62f7a` | a bounded envelope naming the project, claiming nothing it did not resolve |
| `b5ee8bbe7` | a Project A agent cannot be handed Project B |
| `69557d3bd` | `check:agent-turn-location-authority` (its message's CI claim is wrong — see below) |
| `e5636a60d` | product reality in real Electron, no credential needed |
| `937d9ef44` | the inherited `conversations-reachability` cleanup debt, closed |
| `94973071d` | gate placed in `pr.yml`; corrects `69557d3bd` |

**Coherence anchors — all five must pass before mutating anything:**

```
node config/scripts/check-durable-actor-catalogs.mjs          # 1/1 durable actor catalogs
node config/scripts/check-agent-identity-authority.mjs        # one AgentId minter
node config/scripts/check-recurring-work-inventory.mjs        # debt=0
node config/scripts/check-agent-instruction-layer.mjs         # no baseInstructions
node config/scripts/check-agent-turn-location-authority.mjs   # no invented location
```

### Verified this wave

- **Product reality, real Electron, 1 passed (54.5s)** — and it needs **no Codex credential**,
  because the project gate sits before the auth gate: reaching `auth-required` is positive
  evidence the project resolved. Control: forget the project, get `project-not-set-up`,
  nothing committed.
- **8 unit mutations + 1 product mutation, all caught**, every restore SHA-256 verified. The
  product mutant (refusal removed) reddened exactly `expect(refused).toBe('project-not-set-up')`.
- Typechecks node/cli/web exit 0, bracketed on a stable dirty-path set. 125 passed / 5 skipped
  across `src/main/conversation` + `src/main/ipc/conversations.test.ts`.

## 3. Active decisions (do not relitigate)

- **The agent's project decides where its turn runs.** Resolved in `runConversationTurn` beside
  `agentFor`, before admission. A window focused elsewhere cannot retarget it.
- **Agents FOLLOW succession; automations PIN.** Opposite laws, both correct, reasons written in
  `agent-project-location.ts` and `automations/run-target-resolution.ts`. Do not "harmonise" them.
- **An absent cwd stays absent.** `process.cwd()` is gated off the turn path. What nothing locates
  falls back to the user's home — declared, not incidental.
- **Four location outcomes stay four.** `no-project` is a legal state, not a refusal; `unresolved`,
  `not-ready` and `remote-host` each get their own sentence because each sends a person elsewhere.
- **`createForAgent` takes no project.** The agent owns it. `ConversationRecord.projectId` stays
  for Brainstorming with no production producer — deliberate, documented, not a bug to "fix".
- **`developerInstructions` only.** `baseInstructions` replaces the provider's own and is gated.
- **The envelope claims only what was resolved.** No branch, commit, freshness or file contents.

## 4. Open, named, not hidden

- **The real-provider leg has still NEVER RUN.** Measured again this session: no `auth.json` in
  `~/.codex` or `%APPDATA%\orca\codex-runtime-home\home`. The Owner must `codex login` first.
  Codex's acceptance of `developerInstructions` remains schema-only.
- **No provider has ever been observed USING the project directory.** W-C5 proves the turn is
  *located* and *told* — structurally, and in real Electron. Whether the model then reads
  `AGENTS.md` and answers better is unproven and needs the real-provider leg.
- **`69557d3bd`'s message is wrong** where it says `check:agent-instruction-layer` "ran nowhere":
  it has had its own `pr.yml` step since W-C4. Corrected in `70f2a1c86`, not rewritten.
- **CI is DEFINED, not EXECUTED.** The new gate has a `pr.yml` step; this fork's PR runs are still
  assigned `runner_id=0`. Definition and execution are different claims.
- **A resumed provider thread keeps its ORIGINAL directory.** Measured: `thread/resume` sends no
  `cwd` (`codex-conversation-driver.ts`), because a Codex thread takes its directory at
  `thread/start`. So an agent whose project binding changes keeps reading the old project on its
  existing thread while Orca has resolved the new one. Orca's own layers are correct — the runner
  and the turn request both carry the new path — and the last hop drops it. Not fixed blind: the
  spec's measured surface does not record whether `thread/resume` accepts `cwd`, and these schemas
  are strict, so an unknown field is rejected rather than ignored. Pinned by the exact `toEqual` in
  `codex-conversation-driver.test.ts`.
- **Remote-host projects refuse.** An agent whose project lives only on an ssh/runtime host cannot
  chat. That is honest, not finished — it is the natural W-C6 candidate.
- The memory index sits at **169 lines / ~22 KB** against a 200-line read limit. Not over, but
  a real compaction pass is owed.

## 5. Next three actions

1. **Run the real-provider gate** once the Owner has signed Codex in, then extend it to ask a
   question answerable only from a file in the bound project, with a no-project control.
2. **W-C6 candidate — a remote project's agent.** The refusal is the seam: an agent bound to an
   ssh/runtime project currently cannot chat at all.
3. Compact the memory index below 140 lines without dropping pointers.

## 6. Start instruction

Read §2, run the five coherence anchors, confirm `git worktree list` puts you in
`C:\Users\User\Apps\orca-cogws-wt` on `orca-x/cognitive-workspace`, then begin at §5.
Do not rebuild anything in §2 — it is sealed and proven in a real Electron run.
