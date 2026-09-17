# Design System

All UI work — layout, color, typography, spacing, component selection, UX behavior — must follow [`docs/STYLEGUIDE.md`](./docs/STYLEGUIDE.md). Use the tokens defined in `src/renderer/src/assets/main.css` (the canonical source) and the shadcn primitives in `src/renderer/src/components/ui/`. Don't invent new color values, font sizes, or shadow tiers when a documented one already covers the role. When STYLEGUIDE.md is silent, follow the resolution order in its final section.

## Electron UI Validation

Use the `$electron` skill and Playwright CDP for rendered Orca UI checks. Do not use computer-use for Orca UI validation.

# Style
## Concise/Brief Non-obviosu comments ONLY
  * DO NOT: be verbose, explain the obvious, walk through the code ("WHY not HOW")
  * BE CONCISE. 1 LINE if possible

## Lint Rules: Do Not Disable Max Lines

NEVER add a `max-lines` disable (`eslint-disable max-lines`, `oxlint-disable max-lines`, or line-specific variants), and never add a per-file `max-lines` bump in `mobile/.oxlintrc.json`.

## File and Module Naming

Never use vague names like `helpers`, `utils`, `common`, `misc`, or `shared-stuff` for files, folders, or modules. They carry zero info and tend to become dumping grounds. Name files after what they _actually_ contain — prefer the concrete domain concept (e.g. `tab-group-state.ts`, `terminal-orphan-cleanup.ts`) over the generic role (`tabs-helpers.ts`, `terminal-utils.ts`). If you find yourself reaching for `helpers`, the file probably has more than one responsibility and should be split, or there's a better name hiding in the code that describes what the functions operate on.

## Type Declarations: Prefer `.ts` Over `.d.ts`

# Considerations
## Worktree Safety

Always use the primary working directory (the worktree) for all file reads and edits. Never follow absolute paths from subagent results that point to the main repo.

## Cross-Platform Support

Orca targets macOS, Linux, and Windows. Keep all platform-dependent behavior behind runtime checks:

- **Keyboard shortcuts**: Never hardcode `e.metaKey`. Use a platform check (`navigator.userAgent.includes('Mac')`) to pick `metaKey` on Mac and `ctrlKey` on Linux/Windows. Electron menu accelerators should use `CmdOrCtrl`.
- **Shortcut labels in UI**: Display `⌘` / `⇧` on Mac and `Ctrl+` / `Shift+` on other platforms.
- **File paths**: Use `path.join` or Electron/Node path utilities — never assume `/` or `\`.
- **Windows setup scripts**: the setup/issue-command runner is a `.cmd` batch file unless the script starts with a `#!` line — never derive that from the user's terminal-shell preference, and never launch a `.cmd` runner with a bare `cmd.exe /c` from a Git Bash pane (MSYS rewrites the `/c`). See [`docs/reference/windows-setup-shell.md`](./docs/reference/windows-setup-shell.md).
- **Linux native modules**: keep the glibc floor at Ubuntu 20.04 / glibc 2.31. A module compiled from source on a newer runner can reference symbol versions absent on the floor and crash the app on startup. See [`docs/reference/linux-glibc-compatibility.md`](./docs/reference/linux-glibc-compatibility.md); packaging fails if a bundled native binary needs newer glibc.

## SSH Use Case

All changes must consider the SSH use case. Don't assume local-only execution.

## Folder Workspace Use Case

All changes must consider folder workspaces as well as git worktrees. Don't assume every workspace is a git worktree.

## Remote Wire Compatibility

Clients and remote Orca servers update independently, so mixed versions are the normal state. Before changing anything a paired client and host exchange — RPC params, stream frames, or the content either side publishes over them — follow [`docs/reference/remote-wire-compatibility.md`](./docs/reference/remote-wire-compatibility.md). A new optional field is safe; a new stream opcode must be capability-negotiated because decoders drop unknown opcodes silently; and changing what the host publishes reaches old clients even with no wire change.

## Layout Ownership

A container that takes its width from its content must not be the width authority for a sibling that has its own intended size. When a chrome header and a sized panel share an auto-width column, the column takes the header's max-content width and the remainder becomes a band no surface paints — a white gap in light mode, a large black block in dark. Keep the sized panel the authority and let the header render inside it (`w-0 min-w-full` contributes nothing to the parent's intrinsic width while still painting full width).

The same circularity silently disables overflow guards. `AppMenuStrip` collapses when it does not fit, measured against `.titlebar-left` — but while the strip set that header's width it was measuring a space it had created, so it always fit and never collapsed. If a fit check compares a child against an ancestor the child can stretch, the check is dead code.

Two habits follow. Header content width is often **localized**, so a layout defect can exist in one language and not another; a gap that reproduces in Spanish may be invisible in English. And diagnose voids by measuring the rendered gap between two *named* surfaces in the running app — a generic "large element with no children" scan flags legitimate cases such as `xterm-viewport`. `tests/e2e/workspace-left-column-geometry.spec.ts` is the worked example.

## Durable State

If a feature persists state that a crash or power loss could destroy, it needs a contract in [`config/durability-contracts.jsonc`](./config/durability-contracts.jsonc), not just a working write. Say what the state is, what breaks if it disappears, and its tier.

Durability is proportional to that answer. `crash-durable` state — the only copy of something the user would notice losing, or the target of a pointer that is itself fsynced — must carry a barrier before the rename (route through [`src/main/durable-file-write.ts`](./src/main/durable-file-write.ts)) and a syscall-order proof, because a successful write is not a durable one and an fsync moved after the rename still fsyncs a file. `atomic-only` state must never be observed torn but may lose its newest write. `regenerable` state owes nothing.

Three failure shapes recur and are worth checking for by name. A **durable pointer outliving a non-durable referent** (the ref is fsynced, the blob it names is not). **Failure collapsing into empty** (an unreadable file reported as an empty one, which turns a transient error into data loss when a read-modify-write publishes it back). And **intent outliving commit** — a completion marker, migration stamp or "done" flag that becomes durable before the state it certifies. That one is worst when the marker's *existence* is what gates the retry, because the inconsistency is then terminal: the work never runs again. If you write a marker, make the state it describes durable first, and prefer a retry gate that can re-derive the truth over one that trusts the flag.

A state file also owes a rule about its own backup: never spend the last known-good copy on a degenerate one. Rolling a backup forward from a file that is empty or unparseable destroys both copies in a single operation, so gate the rotation on the current file actually being worth keeping (`profile-index-store.ts` and `config-toml-trust.ts` both do this).

`pnpm check:durability-contracts` enforces this. Modules that stage a temp file and rename it into place but carry no contract are ratcheted in `config/durability-unclassified-baseline.txt`: the existing ones are grandfathered and the list may only shrink, so a **new** unclassified publisher fails the gate. Prune with `--prune` after classifying one.

## Forked IPC Children

Fork through `forkIpcChild()` ([`src/shared/ipc-message-listener-floor.ts`](./src/shared/ipc-message-listener-floor.ts)), or call `installIpcMessageListenerFloor(child)` when the fork itself is injectable. `pnpm check:ipc-message-floor` fails on any file under `src/` that owns an IPC child without one, and `config/ipc-message-floor-baseline.txt` only shrinks.

Node delivers an IPC message a tick after reading it and checks the channel only when it *schedules*. On that later tick a child with no `'message'` listener sends node into `target.channel[kPendingMessages]` — and `channel` is null once `disconnect()` ran or the child exited. The host then dies on `TypeError: Cannot read properties of null (reading 'Symbol(kPendingMessages)')` thrown from a tick, which no call site can catch; in main that is the "A JavaScript error occurred in the main process" dialog. The floor keeps one no-op listener attached for the child's whole life, so node can only take the branch that never touches the channel, and it replays what it absorbs so the queue-until-someone-listens behaviour is not lost.

`fork()` always creates an IPC channel, so a site is exposed even with no `'ipc'` in its `stdio`. The teardown that arms the crash — dropping the last `'message'` listener, then disconnecting or killing — usually lives in a different function from the fork, which is why this is a gate rather than a code-review note. `removeAllListeners()` on a child is the sharpest form: it takes node's own internal handlers with it.

## Git Binary Compatibility

Orca runs the user's Git binary on native, WSL, and SSH hosts, which may all have different versions. Treat Git 2.25 as the core-workflow baseline and follow [`docs/reference/git-compatibility.md`](./docs/reference/git-compatibility.md).

When adding or changing a Git command:

- Check when every subcommand and option was introduced. For newer behavior, keep a baseline-compatible fallback or degrade safely.
- Use `GitCapabilityCache` with a narrow unsupported-error predicate so recurring operations do not retry a known-invalid command. Do not rely only on `git --version`; wrappers such as `simple-git` do not remove host-version differences.
- Scope capability state to the host that executes Git: native, WSL distro, SSH provider, or relay connection. Cover the first fallback, later cached calls, concurrent probes, and relevant host isolation in tests.
- Keep the real-binary compatibility contract in PR CI current. When adopting a newer Git feature, add its version boundary so the preferred command and fallback both run against representative Git releases.
- Preserve commands that begin with global Git options such as `-c` before the subcommand, including auto-maintenance suppression used by worktree-create fetches.

## Git Provider Compatibility

Source-control and review changes must consider GitLab and other supported git providers, not only GitHub. Keep provider-specific behavior behind explicit checks, and avoid GitHub-only naming for generic review concepts.

## GitHub CLI Usage

Be mindful of the user's `gh` CLI API rate limit — batch requests where possible and avoid unnecessary calls. All code, commands, and scripts must be compatible with macOS, Linux, and Windows.
