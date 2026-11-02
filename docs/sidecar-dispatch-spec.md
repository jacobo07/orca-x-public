---
covers: [sidecar-dispatch, observe-only-server, worker-terminal-tag, task-spec-file, headless-coordinator]
tier: T3
status: draft r2 (2026-11-02; architecture audit r1 applied, 15 gaps)
---

# Sidecar dispatch: four changes so an outside cockpit can send work through Orca

## Why

The InfinityOps Sidecar (a desktop app, not an Orca terminal) shows the Owner's hosts through Orca (built) and is
to send tasks to Claude Code on them (InfinityOps spec `vault/specs/sidecar-window-w2-fleet-f2.md`, r3). Four gaps
in Orca stand in the way; each is a change here, useful on its own, and inert when nobody uses it.

| | Gap (measured at origin/main eb690201c; paths under `src/`) | Change |
|---|---|---|
| K1 | Every server accepts federated workers and remote terminals; a host paired read-only can be given a worker by any Orca terminal on a paired PC | `serve --observe-only` |
| K2 | No variable tells a worker's terminal apart: every Orca terminal gets `ORCA_TERMINAL_HANDLE` | `ORCA_WORKER_DISPATCH_ID` on worker terminals |
| K3 | `task-create` takes the task only as `--spec <text>` on the command line (Windows 32 767 UTF-16 units; readable by same-user processes and process auditing) | `--spec-file <path>` |
| K4 | Orchestration is terminal-bound: run-create, task-create and worker-start need a coordinator pane | a coordinator without a terminal |

Base: eb690201c is the deployed 1399cb2eb plus two native-chat UI commits (slash-command TUI picker); neither touches
RPC, PTY, orchestration or serve.

## K1 — `orca serve --observe-only`

- **Where.** One refusal point for paired clients: `handleWebSocketMessage` (`main/runtime/runtime-rpc.ts` ~1801),
  beside the existing `MOBILE_RPC_METHOD_ALLOWLIST` check and reusing its pattern. Direct WebSocket and relay both
  reach it (`MobileSocketWiring.onText`, ~1453-1462); binary frames reach only handlers an allowed streaming method
  registered (~1131-1148), so they are closed with it. Nothing runs before it: not the legacy compatibility routing
  (`rpc/dispatcher.ts:83-89`) and not the mutation receipt (`rpc/orchestration-mutation-executor.ts:65`).
- **What.** An allowlist of exact method strings, fail closed (a method added later is refused until listed). The
  list is taken from a captured trace, not from memory, of three real consumers against the server: (1) the home's
  fleet observation (`main/fleet/fleet-observation-service.ts`: `status.get`, `diagnostics.memory`,
  `fleet.nodeResources`); (2) the Sidecar F1 reads (worktree/repo/terminal lists, `orchestration.workerList`);
  (3) opening the host in the desktop app through the shared-control path
  (`main/ipc/runtime-environment-transport-routing.ts:145-160`). The trace and the resulting list are committed with
  the change. Terminal *output* reads and every create/send/stop/attach are outside it. Refusal code:
  `server_observe_only`.
- **Capability.** An observe-only server withholds the worker-federation capability in `status.get`, so the home's
  existing preflight (`rpc/methods/orchestration-federated-worker-start.ts` ~64) refuses with `capability_unsupported`
  before any remote call, and the dispatch ends as **failed**, not unknown. `server_observe_only` is also added to the
  known failure codes (~233, 268-276) for a client that skips the preflight.
- The local desktop app on that host and its local CLI are not paired clients and are unaffected.
- `docs/reference/headless-linux-server.md` gains the flag; the InfinityOps production unit adds it.
- **Tests.** For each refused method: before/after counts of receipts, dispatch and attachment rows, PTYs and
  worktrees are equal. Each allowlisted read still answers. A method not in the list is refused. The F1 view of the
  host is unchanged under the flag. Red run: with the allowlist check disabled the refusal tests fail. Real-host
  drill: from a raw Orca terminal on a paired PC, `orchestration worker-start --on vps-prod …` ends **failed**
  (`capability_unsupported`) and nothing appears on prod.

## K2 — `ORCA_WORKER_DISPATCH_ID`

- The terminal Orca creates for a supervised worker carries `ORCA_WORKER_DISPATCH_ID=<dispatchId>`. The dispatch row
  exists before the terminal is created (`rpc/methods/orchestration-workers.ts:120`; federated id from the home,
  `orchestration-federation.ts:54-55`).
- **All three env paths** strip an inherited or caller-supplied value and stamp it only from the trusted creation
  context, like the trusted-handle rule: local provider `buildSpawnEnv` (`main/ipc/pty.ts` ~2573), the
  connection/SSH spawn with IPC-supplied env (~4793-4803), the daemon spawn (~6664). WSL rides the local path.
- **Adopted terminals cannot be tagged** (a live process cannot gain a variable): a worker started on an existing
  `--terminal` is untagged. Stated in the help text; the Sidecar never passes `--terminal`.
- Not a security boundary (a process can unset its own variable). It lets a user-level hook refuse `git push`
  inside workers without touching the Owner's own sessions.
- **Tests.** Tagged on local, daemon, SSH and WSL worker terminals; absent from an ordinary terminal; a spoofed value
  in base env or IPC env is removed; an adopted-terminal worker is untagged. Red run: with the strip removed, the
  spoof test fails.

## K3 — `orchestration task-create --spec-file <path>`

- Mutually exclusive with `--spec`. The CLI reads the file as UTF-8 (at most 256 KiB; a byte-order mark or invalid
  UTF-8 is refused with a typed error; newlines are kept as they are) and sends a body **identical** to the `--spec`
  form, with no path field, so the server's receipt hash (computed over canonical params,
  `orchestration-mutation-executor.ts:35-44`) covers the text only. It never prints the text. The caller owns and
  deletes the file.
- **Tests.** Both flags → `invalid_argument`; missing, oversize, BOM and non-UTF-8 files → typed errors; the same text
  by file and by flag gives the same task and the same receipt hash; a retry with a new file and the same text adopts.

## K4 — coordinator without a terminal

### What exists

- The coordinator is two run columns, `coordinator_handle` + `coordinator_pane_key`, fenced by `consumer_generation`
  (`main/runtime/orchestration/db.ts:384-394`); past handles are kept in `run_coordinator_handles` (`:425-455`);
  `createRun`/`bindRun` bump the generation and fence the outstanding delivery (`:2479-2656`); runs are found by pane
  (`:2697`).
- Mail to the coordinator is a durable mailbox row `run:<id>` (`rpc/methods/orchestration.ts:556-563`, trigger
  `db.ts:2766-2796`) pulled by `check --wait/--ack` (`orchestration.ts:807-913`). The pane pointer is only a nudge and
  already does nothing for a non-terminal handle (`orchestration/mailbox-delivery-target.ts:28-34`). No delivery needs
  a pane.
- Sites that need a pane: `requireCallerPane` (`rpc/methods/orchestration-runs.ts:30-46`); `resolveRunScope`
  (`orchestration-run-scope.ts:47-85`: task create/update, dispatch, reply, check, gates, reviews); `workerStart`'s run
  lookup (`orchestration-workers.ts:31-38`) and local coordinator worktree (`:65-85`,
  `orchestration-worker-topology.ts:134-152`); `missionPlace.boundRun` (`orchestration-mission.ts:44-54`);
  `resolveMessageRun` (`orchestration.ts:342-345`); and two pre-handler sites: the legacy coordinator preflight
  (`orchestration-legacy-compatibility.ts:68-108`, `coordinator-authority.ts:18-95`) and `replayStableCallerParams`
  (`orchestration-mutation-executor.ts:145-166`).
- Caller-supplied identity fields are trusted in places: `check` falls back to `params.terminalPaneKey`
  (`orchestration.ts:768-778`), send/reply use `params.senderPaneKey` (`:330`, `:343`), `resolveRunScope` takes
  `callerPaneKey` first (`orchestration-run-scope.ts:58`). Compatibility evidence is optional (`:17-34`), so a local
  caller can name any live terminal in `--from`. That stays as debt for terminal runs; K4 must not inherit it.

### Change

1. **Name.** `headless:<name>`, where `<name>` is 3-40 of `[a-z0-9-]` and is refused if UUID-shaped, so it can never
   parse as a `tab:leaf` pane key (`shared/stable-pane-id.ts:32-44`) nor suffix-match a real pane (`db.ts:116-127`,
   `:2704-2717`). Handle and synthetic pane key are both that string, in the existing columns.
2. **Token minted by the client.** The client generates a 256-bit token and sends it at `run-create --headless
   <name>` in a body field `coordinatorToken` (from `ORCA_HEADLESS_COORDINATOR_TOKEN`, never argv). The server stores
   only its SHA-256 (new nullable column `runs.coordinator_token_hash`, one migration) and **never returns it**, so the
   mutation receipt (which stores the result, `orchestration-mutation-executor.ts:99-111`) holds no secret, and a
   retry resends the same token. The receipt payload hash covers the hash, not the token.
3. **Every identity field is gated.** A `headless:` value in any of `from`, `terminal`, `terminalPaneKey`,
   `senderPaneKey`, `callerPaneKey`, or in replayed stable caller params, is accepted only after the token verifies
   (constant-time compare against the run's hash); otherwise `coordinator_auth_failed`. Headless identity is accepted
   from local callers only (`isLocalRpcCaller`, verified sound: `runtime-rpc.ts:1689`, `dispatcher.ts:103-118` vs
   paired `1872-1886`, `196-219`); paired remotes get `coordinator_auth_failed`.
4. **One resolver.** `resolveCallerPaneKey` returns the synthetic key for a verified headless caller and
   `getTerminalPaneKey(handle)` otherwise; the sites above call it. The legacy preflight returns not-handled for a
   headless caller; `from` stays a plain string in the payload hash.
5. **Projection.** `runShow`/`runList` (`orchestration-runs.ts:125-138`) never return `coordinator_token_hash`.
6. **Rebind and rotation.** `run-use --headless <name>` with the current token rebinds (generation bump, delivery
   fenced) and may carry `newCoordinatorToken` to rotate the hash in the same transaction.
7. **Lost token.** Recovery is a local-only verb, `orchestration run-reset-coordinator --run <id> --headless <name>`,
   accepted only from the local desktop's own UI confirmation path (not the CLI alone), which sets a new hash supplied
   by the caller, bumps the generation and fences the outstanding delivery. Running workers keep going; their
   `worker_done` stays in the mailbox and is read after the reset. If the Owner instead abandons the run,
   `orchestration run-abandon --run <id>` stops and releases its workers without a coordinator. Both are logged as run
   events.
8. **Worker start without a coordinator worktree.** For a headless caller `worker-start` requires `--on` with
   `--worktree new-top-level --repo <exact> --name`, or a local exact `--worktree <selector>`/`--repo`; `current` and
   `new-child` are refused with `headless_coordinator_has_no_worktree`; `--terminal` is refused (K2). Lineage records
   no caller terminal (`orchestration-worker-topology.ts:151`).
9. **CLI.** With `ORCA_HEADLESS_COORDINATOR` set, the CLI sends only the headless identity and token: it omits
   compatibility evidence (`cli/runtime/orchestration-compatibility-envelope.ts:10`), `ORCA_PANE_KEY` and
   `ORCA_TERMINAL_HANDLE`, and never falls back to the focused terminal. Without it, behaviour is exactly today's.
10. **Preamble.** Names `headless:<name>` as the coordinator (`orchestration/preamble.ts:61`); `worker_done` and
    `send --to headless:<name>` route to `run:<id>` through the existing trigger.

### Tests

Headless run-create from a local caller works and returns no token; the receipt row contains no token; from a paired
remote it is refused. For each identity field (`from`, `terminal`, `terminalPaneKey`, `senderPaneKey`,
`callerPaneKey`, replayed params): a `headless:` value without the token is `coordinator_auth_failed` and the mailbox
is unread afterwards. UUID-shaped names refused. task-create, federated worker-start, worker-stop/release and
`check --wait --ack` work headless; `worker_done` and an `ask` reach the headless mailbox and `reply` answers it;
`current`/`new-child`/`--terminal` refused for headless; rebind fences the previous delivery; rotation invalidates the
old token; reset and abandon behave as stated; run show/list omit the hash; with all three of
`ORCA_TERMINAL_HANDLE`/`ORCA_PANE_KEY`/evidence set, a headless call still resolves headless; the existing
terminal-coordinator suites pass unchanged. Red runs: token check skipped → the gating tests fail; field gate removed
for `terminalPaneKey` → its test fails.

## Out of scope

The gate decision verb for subject-bound gates (InfinityOps F3) gets its own spec. No change here alters how a
terminal coordinator works today; the existing `--from` impersonation for terminal runs is recorded debt.

## Rollout and rollback

One build from this branch (rebased on main at merge time), deployed to all four hosts like the F0.5 rebuild in
InfinityOps spec `sidecar-window-w2-fleet.md` 3.2; vps-prod restarted with `--observe-only`. Downgrade drill before
deploy: the previous build (1399cb2eb) started against a database migrated by this one either runs (the new column
ignored) or refuses on a schema-version fence; the result is recorded, and the previous `/opt/orca/<ver>` dirs stay
until it passes.
