# Detach, Stop Execution and Cancel Workstream

Three effects, three names, three authorities. They are never interchangeable, and a client
disconnect is only ever the first one.

## Status

| Effect | Status | Triggered by | Authority | May touch | Refusal vocabulary | Proof |
| --- | --- | --- | --- | --- | --- | --- |
| Detach control surface | LIVE | window close, client disconnect, app quit | the transport | the socket and observation streams only; never an Execution or a Workstream | none (it is not a command) | `src/main/runtime/runtime-rpc-client-disconnect.characterization.test.ts`, `src/main/runtime/rpc/effect-class-registry.test.ts`, `src/main/runtime/orca-runtime-agent-session-detach.test.ts`, `src/renderer/src/components/terminal-pane/remote-runtime-pty-transport-detach-sends-no-stop.test.ts`, `src/main/quit-path-local-runtime-teardown.characterization.test.ts` |
| Stop Execution | LIVE | an explicit user action | the runtime that owns the Execution | one Execution (a PTY set); the Workstream remains | `STOP_EXECUTION_REFUSAL_CODES` | `src/main/runtime/rpc/errors.test.ts`, `src/shared/execution-effect-refusals.test.ts` |
| Cancel Workstream: ABSENT (refuses) | ABSENT | an explicit operator request | UWCP `uwcp.control/1` (not built) | nothing in this runtime | `CANCEL_WORKSTREAM_REFUSAL_CODES` | `src/main/runtime/rpc/methods/workstream-cancel.test.ts` |

## Stop Execution

Stop Execution is the existing terminal effect, named; there is no second stop path.

- `terminal.stopExact`: one execution, the row kept. This is what Sleep uses.
- `terminal.stop`: sweep every Execution of a worktree.
- `terminal.sleep` and `worktree.sleep`: Stop plus a sleep checkpoint.
- `terminal.close` and `terminal.closeTab`: Stop plus retire the row.

Only an explicit user action is Stop. Window close, disconnect and quit are Detach.

### Refusal vocabulary

The codes are the strings the runtime already ships, frozen in `src/shared/execution-effect-refusals.ts`.
They now reach the wire as `error.code`; `error.message` is unchanged, so an old client sees what it saw.

- Not found or already stopped: `terminal_stop_pty_set_mismatch`, `terminal_handle_stale`. "Already
  stopped" has no dedicated code; it surfaces as `terminal_stop_pty_set_mismatch`.
- Runtime unreachable: `terminal_liveness_unavailable`, `remote_runtime_unavailable`.
- Stop refused or failed: `terminal_exact_stop_requires_single_pty`, `terminal_exact_stop_unavailable`,
  `terminal_exact_stop_failed`.

`terminal_exact_stop_still_live` is a result field (`postStopFailure`), not a refusal, and is not in the list.

## Cancel Workstream: ABSENT (refuses)

`workstream.cancel` is a separately named RPC (runtime scope, not on the mobile allowlist, no CLI verb).
Its only outcome today is the refusal `workstream_authority_unavailable`, with `data.authority` set to
`uwcp.control/1`. It never reports success, its handler takes no runtime context so it cannot reach any
stop, close or sleep effect, and the Stop and Cancel vocabularies are disjoint. A Stop request never
reaches the Cancel handler.

## The launch effect class

A new RPC that launches or mutates an Execution declares `effect: 'launch'` and receives no socket abort;
`waitSignal` only ends waits. Observation and streaming RPCs keep aborting on socket close.

## Mixed versions

- An old host still aborts launches on disconnect: the Detach guarantee is a property of the host version.
- An old host answers `workstream.cancel` with `method_not_found`. A client must read that as a Cancel
  refusal and never as a reason to fall back to a Stop.

## Dispositions

- `skills.*` installs still cancel on socket close. They are a mutation, not an Execution, and are out of Phase 3.
- `closeRemoteTerminal` is Stop of an Execution the same transport created and nobody adopted.

## Proof command

```bash
node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/shared/execution-effect-refusals.test.ts src/main/runtime/rpc/errors.test.ts src/main/runtime/rpc/methods/workstream-cancel.test.ts src/main/runtime/rpc/effect-class-registry.test.ts src/main/runtime/runtime-rpc-client-disconnect.characterization.test.ts config/scripts/workstream-surface.characterization.test.mjs
```
