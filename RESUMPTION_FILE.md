# RESUMPTION — Orca X true multi-window workspace (W5/W6)

Repo: `C:\Users\User\Desktop\Cursor Projects\Vibe Coding Projects\Orca X`, branch `orca-x/w0-durability-repros`.
Thesis: turn Orca from a single-window app into one application with many independently owned project
Workspace windows, then expose it as **Archivo → Abrir nueva ventana**. The menu item is the last
step, not the first, and it still has not shipped — deliberately.

## Spec of record

`docs/workspace-window-mode-plan.md` — **gitignored** (`.gitignore:92 docs/**`), so `git log` cannot
see it. It carries the ownership model and the measured decomposition of both blockers.

## Two corrections — do not re-inherit the old claims

1. **Per-PTY output routing already exists.** `ipc/pty-renderer-ownership.ts` landed 2026-08-20
   (`763982ac3`) with tests; every pty-id-carrying send already routes through `deliveryWindowFor`.
   The spec's "its own project, 7,926 lines" verdict predates it. What remains is the *input* gate
   (`isPtyWriteEventFromMainWindow`, `pty.ts:7231`) plus a few lifecycle sends still closing over
   `mainWindow`.
2. **`updater:*` is not stolen.** `registerUpdaterHandlers` is called once from
   `register-core-handlers.ts:231` and takes no window; only `setupAutoUpdater`'s push sink
   (`updater.ts:117`) retargets.

## Exact state

Sealed this session:

- `1616a4063 fix(window): stop a second window taking the first one's services` —
  `window/window-service-ipc-router.ts` registers `app:reload`, the four `macosTccPrompts:*` channels
  and the native file-drop relay **once** and routes them by sender, with the binding map as the
  membership test. Eight existing cases that asserted the singleton as the contract were retargeted.
  RED proven first: 4/4, including that closing window B never gave window A its reload back.
- `de05686a1 feat(ipc): send global registry changes to every window` — `repos:changed` and
  `worktrees:changed` now fan out to every registered window, skipping the origin.
- `2ba8b149d test(runtime): pin the per-window runtime graph as a skipped specification`.

## Next 3 actions

1. **Blocker B — the whole of it, or none of it.** `OrcaRuntimeService.attachWindow`
   (`orca-runtime.ts:6413`) falls off the end for a second real window. Five single-consumer
   mechanisms sit under it (one authority scalar at 26 sites, one notifier slot, one global epoch,
   one reload fence, ~12 flat graph maps replaced wholesale). The merge is feasible with **no wire
   change** — `RuntimeSyncedTab`/`RuntimeSyncedLeaf` already carry `worktreeId`. But
   `beginGraphReload` and `markGraphUnavailable` clear handles, waiters and incarnations globally, so
   partitioning only tabs and leaves is **half-safe**: window A reloading would still strip window
   B's live handles. Start by unskipping `runtime/graph-window-ownership.test.ts` — it is the
   executable spec and fails 4/4 for the four right reasons. Blast radius: 128 test files in
   `src/main/runtime`.
2. **Finish Blocker A's redirect half**: SSH (`currentGetMainWindow`, `ssh.ts:73`), remote-workspace
   (`mainWindowGetter`), the updater status push, and the two directory watchers. Also the three
   `dialog.showOpenDialog(mainWindow, …)` at `repos.ts:2352/2362/2373` — parenting them to
   `BrowserWindow.fromWebContents(event.sender)` needs a **value** import of `BrowserWindow` into
   repos.ts, which risks the electron-mock surface across its test files; give it its own commit.
3. Only then `window:create`, the Archivo item, the accelerator and localization.

## Baseline — re-measure, never inherit

Measured at `1616a4063` by stashing the working changes: **84 failed / 3249 passed / 47 skipped**
across 15 files for `src/main/ipc src/main/window`. Earlier notes said 90 and a truncated run said
81 — three records that never agreed. Keep the **failing-file list**, not just a total. The 15:
`ephemeral-vm` (8), `ephemeral-vm-provisioned-root-ref` (1), `filesystem-list-files-git-fallback-real`
(1), `filesystem-watcher-local-unsubscribe` (7), `folder-repo-git-upgrade` (19),
`local-network-connection-test` (1), `mobile` (1), `native-chat` (3), `pty-codex-account-attribution`
(2), `pty-daemon-spawn-wsl-runtime` (1), `pty-spawn-env-codex-resume-provenance` (1),
`worktree-base-directory-event-filter` (6), `worktree-base-directory-watcher` (20),
`worktree-symlinks` (9), `clipboard-file-copy` (4). Many are Windows environment:
`EPERM: operation not permitted, symlink` (needs elevation or developer mode) alone accounts for
`folder-repo-git-upgrade` 19/19.

## Running anything on this host

- **`npx` is broken here.** Build with `pnpm exec electron-vite build --mode e2e`, run specs with
  `SKIP_BUILD=1 pnpm exec playwright test …`.
- **`git` is not on PowerShell's non-interactive PATH.** Prepend `C:\Program Files\Git\cmd`.
- **Native modules need the VS toolchain by hand** (`vcvars64.bat`); vswhere does not see the install.
- **Never run `grep`/`ls`/`cat` through the Bash tool** — it hangs. Use Grep/Glob/Read. `Grep` scoped
  to all of `src/main` can time out; scope to a subdirectory.
- **Capture test output whole** (`*> $log`) and select from the file; never narrow at capture time,
  and never run a baseline while editing the tree it measures.

## Start instruction

Read `docs/workspace-window-mode-plan.md`, then `git log --oneline -8`. Continue at action 1. Every
change lands as its own micro-commit with a RED proven first, and every run is compared against a
freshly measured baseline before anything is called a regression.
