---
covers: [park-and-exit, durable-exit, workspace-sleep-dormancy]
---

# Durable park and exit

Status: spec of record for the Park-and-Exit wave (2026-09-17).

## Why this exists

A normal quit disconnects from the terminal daemon and deliberately leaves its sessions (and the
agent processes inside them) running, so the next launch reattaches warm. That is pinned by
`src/main/quit-path-resource-flow-isolation.test.ts` and must stay true.

Sometimes the user wants the opposite: keep the work, but free the machine. Park and exit is that
request. It is a transaction, not a button:

1. **Plan** — classify every workspace: can all of its terminals be released without losing work?
2. **Refuse or proceed** — a safe park refuses if anything would be kept. Nothing is destroyed.
3. **Seal** — capture resume ids and flush the workspace session, so what is about to be released
   can be reconstructed.
4. **Release** — put each safe workspace to sleep through the existing workspace Sleep effect,
   re-planning that workspace immediately before its own sleep. The released set only shrinks.
5. **Verify** — every released workspace has no process and every row is dormant; the host lists
   no live session for those rows; the flushed session is read back.
6. **Exit** — quit through the normal path. With no live sessions, the daemon's existing
   `shutdownIfIdle` handshake in `disconnectOnly` retires it. Park and exit adds no kill code.

On the next launch the rows come back dormant (see `TerminalTab.dormancy`, reason
`workspace-sleep`) and nothing runs until a row is opened.

## Callers and authority

One coordinator in main (`src/main/durable-exit/`) owns single-flight and the exit. The renderer
owns the workspace state, so main asks the window to run the plan/seal/release phases over a
request/response channel (the mobile-markdown relay pattern) and never re-derives them.

- Desktop: an app-menu command.
- CLI: `orca park` (plan-only with `--dry-run`), a runtime RPC method on the running app.
- A second request while one runs joins it and receives the same result.

A caller never kills a process. The only destructive effect is the workspace Sleep effect, and the
only daemon retirement is the daemon's own idle proof.

## Safety classification (explicit intent)

An explicit exit is a different authorization from background hibernation, so the Sleep setting
and the idle threshold do not apply. These keep a workspace (with the reason):

| reason                | when                                                               |
| --------------------- | ------------------------------------------------------------------ |
| `agent-working`       | an agent pane is not in `done` state, or was interrupted           |
| `agent-subagents`     | an agent has live subagents or an unsettled dispatch               |
| `agent-not-resumable` | an agent is running with no resumable provider session             |
| `unsent-input`        | the input guard says a draft would be lost                         |
| `mobile-held`         | a phone is driving one of the workspace's terminals                |
| `shell-busy`          | a shell has child processes (a dev server, a build)                |
| `process-unknown`     | the child-process probe could not answer                           |
| `pinned`              | a tab is pinned, unless the caller explicitly includes pinned tabs |

Unknown is never safe. A shell is idle only when its own OSC 133 marker says it sits at a prompt
and no child is reported: on Windows a cmd.exe running `ping` reported no child processes, so the
child probe alone cannot prove idleness. cmd.exe has no markers, so a live cmd.exe tab always keeps
its workspace (`process-unknown`). A workspace that gains a reason between plan and release is reported as
`changed` and left running; one whose sleep throws is `failed`.

## Outcomes

Overall (`src/shared/durable-exit-types.ts`): `planned` (plan only) · `parked` (released
everything, exiting) · `nothing-to-park` (exiting) · `refused` (kept something, nothing released,
still running) · `seal-failed` · `incomplete` (some released, some not; still running) ·
`unavailable` (no window to ask). Per workspace: `would-sleep` · `kept` with reasons · `slept` ·
`changed` · `failed`.

"Parked" is a claim about the rows the app owns. The daemon's retirement is observed after exit
(the CLI waits for it), not asserted beforehand.

## Operating-system session end

Best effort only. On Windows `query-session-end` / `session-end` the app runs the quit path it
already has; the synchronous shutdown checkpoint is the save. No dialog, no park, no waiting on
processes the OS is about to end. What survives an ungraceful end is only what was already
durable: the workspace session (debounced 1 s), agent resume ids (periodic capture), and daemon
scrollback checkpoints.

## Not in this wave

- Updater restart calling park (its pre-quit hook is the natural caller).
- Parking when only the daemon is running (no window to ask; the CLI reports `unavailable`).
- Per-split-pane dormancy; pane hibernation keeps its own in-place wake.
- Windows descendant ownership beyond what the Sleep effect already ends.
