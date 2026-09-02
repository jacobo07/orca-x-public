# RESUMPTION — Orca X true multi-window workspace (W5/W6)

Repo: `C:\Users\User\Desktop\Cursor Projects\Vibe Coding Projects\Orca X`, branch `orca-x/w0-durability-repros`.
Thesis: turn Orca from a single-window app into one application with many independently owned project
Workspace windows, exposed as **Archivo → Abrir nueva ventana**. The menu item has now shipped; what
remains is making the topology survive a restart and proving it in a packaged build.

## Specs of record (both gitignored, `git log` cannot see them)

- `docs/runtime-graph-ownership-spec.md` — the per-window runtime graph. Implemented.
- `docs/workspace-window-mode-plan.md` — the wider ownership model and wave map.

## Sealed this session (8 commits, `623a9cbe2..HEAD`)

1. `623a9cbe2 feat(runtime): give every window its own runtime graph` — Blocker B's core.
   `runtime/runtime-graph-owners.ts` holds the owner registry. Ownership is **derived, not stored**:
   tabs and leaves already carry `worktreeId` and a worktree binds to one window, so the maps stayed
   flat and only the ~15 destructive methods became owner-scoped. The unit that had to move together
   is what a *teardown* destroys — graph maps, handle maps, incarnations, waiters, status, epoch,
   reload fence — not what the UI can see.
2. `315542311 feat(runtime): route renderer commands to the window that owns the target` —
   `runtime/runtime-notifier-router.ts`. Notifiers keyed by window; `this.notifier` is a router over
   them, so the ~70 call sites are untouched. The token guard is deleted: it existed only because
   two windows shared one slot.
3. `72e318cef fix(pty): admit terminal input by ownership instead of by registration` —
   `pty:write` / `pty:writeAccepted` / `pty:claimViewport` now admit by PTY ownership. The old gate
   failed open: the registration window could type into every terminal in the process.
4. `9fd512494 fix(ipc): address global events by what they describe, not by a captured window` —
   SSH state/forwards/ports, remote workspace, updater push, worktree metadata/head identities,
   sparse presets → fanout. Clone progress → the invoking renderer. Folder pickers → the calling
   window.
5. `41ff780c7 fix(window): stop one window's close tearing down the survivors` — automations,
   rate limits and the pop-out survive one window closing; agent status routes by worktree owner.
6. `b54e265ce lint: brace the notifier router for-of bodies` — oxlint `eslint(curly)`, 22 sites.
7. `0f917af0b feat(window): open a new workspace window from File` — `window:create` and
   `window:getStartupBinding` (both gated on the sender), File → New Window on every platform
   including a new macOS File menu, `Mod+Shift+N` freed from `workspace.create` into a new
   `window.new` action, renderer chord + preload bridge, all five locale catalogues.
   `applyWindowStartupBinding` lives in `renderer/src/startup/window-startup-session-binding.ts`.

8. `65525a195` + `435ee6ae4` + `8c548d6df` — **W6 durable window topology.** Model, persistence and
   restore. `ui.windowTopology` in the profile data file; contract `ui.window-topology` at
   atomic-only. Deliberate close forgets one window; a quit freezes the record, which is what a
   crash leaves too, so both restore identically. A recorded binding is *claimed*, not assigned, so
   one-worktree-one-window survives the restart. Geometry is per-window from here.

The release-blocking spec `runtime/graph-window-ownership.test.ts` is **unskipped and 9/9 green**;
`docs/workspace-window-mode-plan.md` had gone stale claiming otherwise and is corrected.

## Next 3 actions

1. **Finish the packaged proof.** A build is running through
   `VC\Auxiliary\Build\vcvars64.bat` — plain `pnpm run build:win` fails at the native rebuild because
   vswhere is broken on this host, not because the compiler is missing. On success: copy the
   installer to the Desktop and verify by hash, never kill a running NSIS run, then exercise
   Archivo → Abrir nueva ventana in the packaged app.
2. **Hoist the PTY delivery machine out of `registerPtyHandlers`** — the last named partition hole.
3. **The final report** — the ~46-section format with a completion verdict.

## Sealed after W6

- `c1b24cd3b` — **the orphan sweep no longer kills another window's terminals.** It asked "which page
  load did this come from", answered by a process-wide generation counter; with two windows, B's
  second reload swept A's running terminals. Now scoped by live ownership
  (`ipc/pty-orphan-sweep-scope.ts`).
- `de0b24f15` — **watchers keep watching for a survivor.** Both captured one window; closing it left
  the survivor with a live watcher that dropped every event, a sync context that cleared itself
  permanently, and an idle upgrade poll. `window/surviving-app-window.ts` is injected by the host so
  the watchers keep no opinion about what an app window is.
- `8d0af94be` — **three-window proof.** Two windows can pass on "mine and everyone-but-me"; the third
  separates owner-scoped from that. Each case pinned on both sides, so neither a no-op nor a
  wholesale teardown goes green.

## Still open, named rather than half-fixed

- `registerPtyHandlers` re-registers per window and `removeAllListeners` first, so the last window to
  attach owns the whole PTY IPC surface. Worse than routing: its accounting maps, pending queue and
  `rendererPtyDispatcherReady` are **closure state rebuilt on every attach**, so a second window
  discards the first window's in-flight accounting and pending output, and the dispatcher-ready
  handshake admits only the last registrant. The fix is a hoist to module scope.
- The watcher-level survivor case is written but **unverified on this host**:
  `worktree-base-directory-watcher.test.ts` is red at HEAD here (39 failures) because it builds
  POSIX-rooted paths the target builder rejects. `surviving-app-window.test.ts` drives all four
  branches of the resolver itself and passes 4/4.

## Baseline — re-measure, never inherit

`src/main/ipc src/main/window`: **90 failures across 15 files**, identical before and after this
session's commits. Every one is a Windows environment red — `spawnSync git ENOENT` (git is not on the
non-interactive PATH) and `EPERM: operation not permitted, symlink` (needs elevation or developer
mode). `src/main/runtime/orca-runtime.test.ts`: 9 failures, all git ENOENT.

`pnpm lint` is red at HEAD for reasons unrelated to this work: `verify:localization-catalog` and
`verify:localization-extraction` both fail on five keys in files nobody here touched
(`components.right.sidebar.leftNavProjectsSwitch.projects`, `auto.lib.launchTerminalProfile.*`,
`auto.lib.terminalProfileAvailability.*`), and `src/renderer/src/lib/launch-command-terminal-profile.ts`
carries two oxlint errors. `verify:localization-coverage` passes. Useful property: those verifiers do
run, and they do **not** name `menu.newWindow` — that is the affirmative evidence the new key is
complete across all five catalogues, not merely unflagged.

Method that worked, after a stash silently failed to revert: copy the modified files to a scratch
directory, `git checkout HEAD -- <paths>` **with the tree-ish**, run, copy back. Verify the revert by
grepping for a token only your change introduces.

## Running anything on this host

- **`npx` is broken here.** Build with `pnpm exec electron-vite build --mode e2e`, run specs with
  `SKIP_BUILD=1 pnpm exec playwright test …`.
- **`git` is not on PowerShell's non-interactive PATH.** Prepend `C:\Program Files\Git\cmd` — the
  repo's own gate scripts (`check:max-lines-ratchet`, durability, reliability) shell out to it and
  crash with ENOENT otherwise.
- **Never run `grep`/`ls`/`cat` through the Bash tool** — it hangs. Use Grep/Glob/Read. A `Grep`
  scoped to all of `src` times out at 20s; scope it to a subdirectory, or use
  `Get-ChildItem -Recurse | Select-String` from PowerShell. A `Select-String` over all of `src` +
  `tests` needs more than 300 s — background it and read the output file.
- **Capture test output whole** (`*> $log`) and select from the file. `src/main/runtime` takes
  ~15 min; `src/main/ipc src/main/window` ~10 min. Never edit the tree while a run measures it.
- Vitest needs `--config config/vitest.config.ts`; without it the `@` aliases do not resolve.

## Start instruction

Read `docs/runtime-graph-ownership-spec.md`, then `git log --oneline -10`. Continue at action 1. Every
change lands as its own micro-commit with a RED proven first, and every run is compared against a
freshly measured baseline before anything is called a regression.
