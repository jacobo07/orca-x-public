# Unsent Input Evidence

A line typed at a prompt and never submitted dies with the PTY. Three destructive paths must refuse
rather than destroy it: closing a terminal, sleeping an agent pane, and parking a workspace.

There are two witnesses, and they fail in opposite directions.

| witness | where it lives | survives a renderer reload | sees input Orca never routed |
| --- | --- | --- | --- |
| `terminalInputPendingByPaneKey` / `lastTerminalInputAtByPaneKey` | renderer store, never persisted | **no** | no |
| `inputSincePrompt` on the host inspection | the PTY's owner | yes | yes |

The host witness is why a reload no longer destroys a draft. The renderer witness is why a shell
with no prompt markers is still protected during normal use. Readers take **either**; neither is
proof of a clean line on its own.

## Who writes the host fact

`inputSincePrompt` is fed from the shell's OSC 133 markers, by the two authorities that own a PTY:

- `src/main/daemon/terminal-host.ts` (the daemon, local and remote alike)
- `src/main/providers/local-pty-provider.ts`

Both retire the line only on a marker the prompt tracker actually believed, so an untrusted prompt
cannot clear a draft. A host that does not track it answers `undefined`, which every reader treats
as unknown — never as an empty line (`src/renderer/src/runtime/runtime-terminal-inspection.ts`).

## Shell support matrix

Measured in the real app by `tests/e2e/shell-unsent-input-support-matrix.spec.ts`:

| shell | `promptState` | after typing a line | draft protected after a reload |
| --- | --- | --- | --- |
| the preferred shell (pwsh on this host) | `prompt` | `typed` | **yes** |
| `cmd.exe` | `unsupported` | `undefined` | **no** — renderer witness only |
| Git Bash (`Git\bin\bash.exe`) | `unsupported` | `undefined` | **no** — renderer witness only |

An embedded startup command is in the same class and is not measured here: the command rides in the
shell's launch arguments and runs before the first prompt, so it emits no markers at all.

## The open decision

On a no-marker shell the host cannot answer, so after a renderer reload nothing witnesses the draft
and a destructive release proceeds. That is a fail-open by construction, and it is deliberate today:

- Close fails open on an answered probe by policy (`running-terminal-close-guard.ts`), because being
  stricter about a draft than about a running command would be incoherent.
- Sleep and Park refuse only on a positive `typed`, because refusing on silence would stop every
  older host from ever sleeping a pane.

Making a no-marker shell refuse instead would protect those drafts and would keep panes awake on
every `cmd.exe` terminal the user ever typed into. That trade has not been taken; it needs a product
decision, not a code change.

## Readers

- `src/renderer/src/lib/pane-shell-idle-check.ts` — resume
- `src/renderer/src/components/terminal/running-terminal-close-guard.ts` — close
- `src/renderer/src/lib/agent-hibernation-coordinator.ts` — agent sleep, at effect time
- `src/renderer/src/lib/durable-exit/park-workspace-plan.ts` — park
