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
| `cmd.exe` | `prompt` | `typed` | **yes** |
| Git Bash (`Git\bin\bash.exe`) | `unsupported` | `undefined` | **no** — renderer witness only |

`cmd.exe` speaks only through `PROMPT` (`src/main/providers/cmd-osc133-prompt.ts`): a tagged 133;A
on every prompt, and a 133;D once no Orca startup command is pending. A pane with no startup command
reports a D on every prompt, so an agent the user types there is seen exiting; a pane whose startup
command is still to be typed draws an A-only first prompt, and a D only after that command returns.
It has no pre-exec hook, so it never emits 133;C. What stands in for it:

- a line the user submits stays `typed` until the prompt returns, so every reader that refuses on
  `typed` treats a running cmd command as unsafe to destroy;
- a startup line the host typed itself is held `running` until its bracketing 133;D, and cmd's first
  prompt (an A with no D) cannot end it;
- a startup command embedded in `/K` runs before any marker, so the host reads `unknown` until it
  returns.

A nested `cmd` inherits the tagged `PROMPT`, so an idle nested cmd reads as an idle prompt.

## The open decision

On a no-marker shell the host cannot answer, so after a renderer reload nothing witnesses the draft
and a destructive release proceeds. That is a fail-open by construction, and it is deliberate today:

- Close fails open on an answered probe by policy (`running-terminal-close-guard.ts`), because being
  stricter about a draft than about a running command would be incoherent.
- Sleep and Park refuse only on a positive `typed`, because refusing on silence would stop every
  older host from ever sleeping a pane.

Making a no-marker shell refuse instead would protect those drafts and would keep panes awake on
every Git Bash terminal the user ever typed into. That trade has not been taken; it needs a product
decision, not a code change.

## Readers

- `src/renderer/src/lib/pane-shell-idle-check.ts` — resume
- `src/renderer/src/components/terminal/running-terminal-close-guard.ts` — close
- `src/renderer/src/lib/agent-hibernation-coordinator.ts` — agent sleep, at effect time
- `src/renderer/src/lib/durable-exit/park-workspace-plan.ts` — park
