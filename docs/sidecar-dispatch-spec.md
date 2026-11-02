---
covers: [sidecar-dispatch, observe-only-server, worker-terminal-tag, task-spec-file, headless-coordinator]
tier: T3
status: draft (2026-11-02; audit pending)
---

# Sidecar dispatch: four changes so an outside cockpit can send work through Orca

## Why

The InfinityOps Sidecar (a desktop app, not an Orca terminal) shows the Owner's hosts through Orca (built) and is
to send tasks to Claude Code on them (InfinityOps spec `vault/specs/sidecar-window-w2-fleet-f2.md`, r3). Four gaps
in Orca stand in the way; each is a change here, useful on its own, and inert when nobody uses it.

| | Gap (measured at origin/main eb690201c) | Change |
|---|---|---|
| K1 | Every server built from this tree accepts federated workers and remote terminals; the production host the Owner pairs read-only can be given a worker by any Orca terminal on a paired PC | `serve --observe-only` |
| K2 | No variable tells a worker's terminal apart: every Orca terminal gets `ORCA_TERMINAL_HANDLE` (`src/main/ipc/pty.ts` env builder) | `ORCA_WORKER_DISPATCH_ID` on worker terminals only |
| K3 | `orchestration task-create` takes the task only as `--spec <text>` on the command line (Windows: 32 767 UTF-16 units in total, readable by same-user processes and process auditing) | `--spec-file <path>` |
| K4 | Orchestration is terminal-bound: `run-create`, `task-create` and `worker-start` need a coordinator pane | a coordinator without a terminal |

## K1 — `orca serve --observe-only`

- A server started with `--observe-only` answers only an **allowlist of read methods** from paired clients: status,
  fleet manifest, environment and runtime status, `repo list/show`, `worktree list/show/ps`, `terminal list`
  (titles and metadata, no output), `orchestration worker-list/worker-show/task-list/gate-list`. Every other method
  from a paired client is refused with a new code `server_observe_only` before any effect. An allowlist, so a method
  added later is refused until someone decides it is a read (fail closed).
- Covered by the refusal, named so a test pins each: `orchestration.federationAttachStart`
  (`src/main/runtime/rpc/methods/orchestration-federation.ts:24`, refused at the top of the handler, before
  `createRemoteDispatchAttachment`), remote terminal create/send/read-output, worktree create/remove, repo add,
  account add.
- The mode is advertised in the server's capabilities (`server.observe-only.v1`) so a client can show it, but the
  server enforces it whatever the client does. The local desktop app is not affected (it is not a paired client).
- `docs/reference/headless-linux-server.md` gains the flag; the InfinityOps production unit adds it.
- Tests: each named effect refused with `server_observe_only` and no row/file/process created; each allowlisted read
  still answers; a method absent from the allowlist is refused (the fail-closed default). Real-host drill: from a raw
  Orca terminal on a paired PC, `orchestration worker-start --on vps-prod …` is refused and nothing appears on prod.

## K2 — `ORCA_WORKER_DISPATCH_ID`

- The terminal Orca creates for a supervised worker carries `ORCA_WORKER_DISPATCH_ID=<dispatchId>`: federated
  (`federationAttachStart`, the startup terminal of `createManagedWorktree`) and local worker-start alike.
- Set by the PTY env builder from a trusted creation context, like the trusted-handle rule for
  `ORCA_TERMINAL_HANDLE` (`pty.ts` ~2572): an inherited or caller-supplied value is deleted unless that terminal was
  created for that dispatch. A new terminal opened from inside a worker therefore does not inherit the tag through
  Orca; a child process of the worker's shell does (that is the point).
- Not a security boundary (a process can unset its own variable); it is what lets a user-level hook refuse
  `git push` inside workers without touching the Owner's own sessions. Documented as such.
- Tests: worker terminal has it (local and federated); an ordinary terminal does not; a spoofed value in base env is
  removed.

## K3 — `orchestration task-create --spec-file <path>`

- Mutually exclusive with `--spec`. The CLI reads the file (UTF-8, at most 256 KiB, no other encoding), sends the
  text in the RPC body as `--spec` does today, and never prints it. The caller owns the file and deletes it.
- The retry-request payload hash covers the text, not the path, so a retry with a new temp file and the same text
  adopts.
- Tests: both flags → `invalid_argument`; missing/oversize/non-UTF-8 file → typed error; same text via file and via
  flag produce the same task and the same receipt hash.

## K4 — coordinator without a terminal

Requirement: the Sidecar owns a Run, creates tasks, starts, stops and releases workers, and reads `worker_done` and
asks without a pane, under exactly the rules a terminal coordinator obeys (fencing, retry receipts, one owner per Run).

### What exists (measured at eb690201c; paths under `src/`)

- The coordinator is two columns on the run row, `coordinator_handle` + `coordinator_pane_key`, with
  `consumer_generation` as the fencing token (`main/runtime/orchestration/db.ts:384-394`); every past coordinator handle
  is kept in `run_coordinator_handles` (`db.ts:425-455`). `createRun` / `bindRun` bump the generation and fence the
  outstanding delivery (`db.ts:2479-2656`). Runs are found by pane (`getCurrentRunForPane`, `db.ts:2697`).
- Mail to the coordinator is a durable mailbox row addressed `run:<id>` (`rpc/methods/orchestration.ts:556-563`,
  trigger `db.ts:2766-2796`); `check --wait/--ack` pulls it (`orchestration.ts:807-913`). Typing a pointer into the
  pane is only a nudge and already does nothing when the handle is not a live terminal
  (`orchestration/mailbox-delivery-target.ts:28-34`). **No delivery needs a pane.**
- What needs a pane: `requireCallerPane` (run-create/use/current, `rpc/methods/orchestration-runs.ts:30-46`);
  `resolveRunScope` (`orchestration-run-scope.ts:47-85`: task create/update, dispatch, reply, check, gates, reviews);
  `workerStart`'s run lookup (`orchestration-workers.ts:31-38`, before the federated branch) and the local path's
  coordinator worktree (`:65-85`, `orchestration-worker-topology.ts:134-152`); `missionPlace.boundRun`
  (`orchestration-mission.ts:44-54`); `resolveMessageRun` (`orchestration.ts:342-345`); the CLI's handle resolution,
  which falls back to the **focused** terminal when no handle is given (`cli/handlers/orchestration.ts:211-241`,
  `cli/selectors.ts:148-160`).
- Caller identity is weak today: compatibility evidence is optional (`orchestration-run-scope.ts:17-34`), so a local
  caller can name any live terminal in `--from`; every local-socket call shares one mutation fingerprint
  (`db.ts:1629-1655`). Not changed here; recorded as debt.

### Change

1. **Identity.** A headless coordinator is named `headless:<name>` (letters, digits, `-`; at most 40). Its synthetic
   pane key is the same string; it has no `tab:leaf` part, so the existing pane-key matching (`db.ts:118-127`,
   `:2702-2718`) treats it as an exact key. Stored in the existing `coordinator_handle` / `coordinator_pane_key`
   columns; `run_coordinator_handles` and the mail trigger work unchanged.
2. **Proof of ownership.** `run-create --headless <name>` returns, once, a random 256-bit coordinator token; the run
   keeps only its hash (new nullable column `runs.coordinator_token_hash`, one migration). Every later headless call
   carries the token in the environment variable `ORCA_HEADLESS_COORDINATOR_TOKEN` (never on argv) and the name in
   `ORCA_HEADLESS_COORDINATOR`. The server compares in constant time; a mismatch is `coordinator_auth_failed`.
   Headless identity is accepted from **local callers only** (`isLocalRpcCaller`); a paired remote is refused.
3. **One resolver.** A single `resolveCallerPaneKey(params, runtime)` returns the synthetic key for a verified
   headless caller and `getTerminalPaneKey(handle)` otherwise; `requireCallerPane`, `resolveRunScope`, `workerStart`,
   `boundRun` and `resolveMessageRun` call it. Nothing else changes in their logic.
4. **Rebind.** `run-use --headless <name>` with the run's token rebinds it (generation bump, outstanding delivery
   fenced), so the client takes its run back after its own restart. A different name, or no token, cannot.
5. **Worker start without a coordinator worktree.** For a headless caller, `worker-start` requires `--on` with
   `--worktree new-top-level --repo <exact> --name`, or a local exact `--worktree <selector>` / `--repo`;
   `current` and `new-child` are refused with `headless_coordinator_has_no_worktree`. Lineage records no caller
   terminal (`orchestration-worker-topology.ts:151`).
6. **CLI.** With `ORCA_HEADLESS_COORDINATOR` set, the CLI sends the headless identity and never falls back to the
   focused terminal or `ORCA_TERMINAL_HANDLE`; without it, behaviour is exactly today's.
7. **Preamble.** The worker preamble names `headless:<name>` as the coordinator (`orchestration/preamble.ts:61`), so a
   worker's `send --to headless:<name>` and `worker_done` route to `run:<id>` through the existing trigger.

### Tests

Headless run-create from a local caller works and returns a token once; from a paired remote it is refused; a wrong
or missing token is `coordinator_auth_failed`; task-create, federated worker-start, worker-stop/release and
`check --wait --ack` work headless; `worker_done` and an `ask` reach the headless mailbox and `reply` answers it;
`current`/`new-child` refused for headless; a rebind fences the previous generation's delivery; a headless call never
picks the focused terminal; the existing terminal-coordinator suites pass unchanged.

## Out of scope

The gate decision verb for subject-bound gates (InfinityOps F3) gets its own spec. No change here alters how a
terminal coordinator works today.

## Rollout

One build from this branch (rebased on main at merge time), deployed to all four hosts like the F0.5 rebuild in
InfinityOps spec `sidecar-window-w2-fleet.md` 3.2; vps-prod restarted with `--observe-only`.
