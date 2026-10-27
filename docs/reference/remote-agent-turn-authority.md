# Remote agent turn authority

How a conversation turn for a project on an ssh host is allowed to execute, what it can never do,
and how each way it fails is represented. Audited 2026-09-24 (Cognitive Workspace, Phase 7).

Scope: every way a conversation turn reaches execution on an ssh host. The subject is the relay's
`agentProcess.*` method family (`src/relay/agent-process-handler.ts`), plus the desktop's remote
driver path.

| Concern | Finding | Evidence (test, where executable) |
|---|---|---|
| Implicit shell | The relay runs ONLY `codex app-server` and `codex login status`; any other command or argv is refused and nothing spawns | `agent-process-handler.test.ts` › "refuses anything but a provider invocation, spawning nothing" |
| Environment as code | The only overlay key accepted is `CODEX_HOME`. `NODE_OPTIONS` or `LD_PRELOAD` would run code under an allowed command name, so they are refused | › "refuses an env overlay beyond CODEX_HOME …" |
| Read implies execute | Conversation threads start `sandbox: read-only`, `approvalPolicy: untrusted`. Every approval the provider asks for is refused while no decider exists; tool CALLs are refused too. A resume sends no sandbox, so a resumed thread keeps its read-only start (provenance only ever holds threads Orca started) | `codex-conversation-driver.test.ts` › "starts a read-only thread …"; `codex-server-request-bridge.test.ts` › "refuses every approval when no authority can decide", "refuses a tool CALL rather than answering it" |
| Pairing scope | `agentProcess.*` exists only on the ssh relay dispatcher. Paired mobile/web clients speak the runtime server, not the relay. The relay has one client, the desktop, authenticated by the ssh session itself | structural; the relay handler is registered in `src/relay/relay.ts` only |
| Remote trust | The desktop resolves WHICH directory; the relay never chooses one. The relay canonicalizes (realpath), refuses a missing directory, and runs in that realpath | › "refuses a project directory that is not there, as its own answer"; rung 3 `/proc/<pid>/cwd` == project |
| Path traversal | `..` in a setup path is resolved by realpath on the host before spawn, so the process runs in the canonical directory. The path comes from the user's own setup, never from provider output or message text | realpath in `defaultAgentProcessHostDeps.isDirectory` |
| Symlink substitution | A setup directory that is a symlink runs in its target, which is the user's own configuration. Replacing it between the desktop's `fs.stat` and the spawn needs write access as the same ssh user, who already holds a shell there. Accepted, and recorded as not a privilege boundary | analysis |
| Cross-project contamination | The location comes only from the agent's own project. Two projects on one host each get their own directory, and a project set up nowhere is refused `unresolved`, never handed a neighbour's | `agent-turn-runs-in-its-project.test.ts` › "runs each agent in its own project on a shared host …"; `agent-project-isolation.test.ts` › "gives two agents in two projects two directories, interleaved" |
| Secrets in observability | The per-turn trace carries ids, host, directory, thread, authority, outcome and reason. It carries no message text, no answer, no env and no credentials | › "names every link of where a remote turn ran, and carries none of what was said" |

## Distinct represented outcomes (criterion 3)

| Failure | Outcome / notice kind |
|---|---|
| host unreachable | `project-unavailable/remote-host-unreachable` |
| pairing missing (runtime-owned host) | `project-unavailable/remote-host` |
| authorization missing | `auth-required` (the detail names the host) |
| path unavailable / worktree absent | `project-unavailable/remote-project-missing` (remote); `unresolved` (local, setup gone) |
| project moved | `project-unavailable/location-changed` |
| host alias changed | the target id is stable across an edit; a target now pointing at a host without the project → `remote-project-missing`, and a removed target → `remote-host-unreachable` |
| stale setup | `project-unavailable/not-ready` |
| remote timeout | `failed` + `cause: timed-out` → `failed-timed-out` |
| host lost mid-turn | `failed` + `cause: host-lost` → `failed-host-lost` (ends at once; `19844a8cd` fixed a 300 s wait) |
| provider missing or too old | `provider-unavailable/not-installed`, `provider-unavailable/protocol-unsupported` |
| provider refused (quota) | `failed` in the provider's own words (`32c8fe92e`; never `completed`) |

`conversation-live-state.test.ts` › "gives every outcome a DIFFERENT kind, so one cannot stand in for
another" holds every kind above apart.

## Distilled — what this program learned, and what enforces it

Written to the knowledge vault (UKDL) for the next program, each with the mechanism that keeps it
true here. A lesson that is only prose decays.

| Law (UKDL entry) | Enforced by |
|---|---|
| `declared-ownership-needs-a-located-effect`, **ascended**: a location is a path AND a host. A thread's history is looked up by host, a remote path never reaches a local process, and a move is followed only as far as the provider can confirm it | `pnpm check:agent-turn-location-authority` fails any host-blind thread lookup in `src/`. Its test catches a future-like violator. Relocation tests drive the version gate and the confirmation rule |
| `a-turn-can-end-without-answering`: settled is not answered; a wait on a notification needs the peer's death signal; the provider's refusal words survive | `codex-turn-event-mapping.test.ts` (verbatim 0.155.1 payloads); runner `reports a turn the provider ended in failure as failed`; integration `ends a turn whose host goes away mid-turn at once` |
| `a-real-channel-you-can-throw-away`: prove a remote effect over a real channel you own, with the real account unreachable by construction | `tests/e2e/agent-chat-remote-project.spec.ts`, run via `.planning/tools/gex44-e2e.ps1` against a private sshd that forces a throwaway HOME |