# RESUMPTION — Orca X true multi-window workspace (W5/W6)

Repo: `C:\Users\User\Desktop\Cursor Projects\Vibe Coding Projects\Orca X`, branch `orca-x/w0-durability-repros`.
Thesis: turn Orca from a single-window app into one application with many independently owned project
Workspace windows, then expose it as **Archivo → Abrir nueva ventana**. The menu item is the last step,
not the first.

## Spec of record

`docs/workspace-window-mode-plan.md` — written in a prior session, still authoritative. W1–W4 and W7 are
done; this work is **W5 (multi-window + session ownership)** and **W6 (window-set recovery)**. Its "W5 —
the decided design" section names the PTY seams and the sequencing rule: per-pty routing must land *with*
the ability to open a second window, never before it.

## Exact state

Sealed (committed, verified green, baseline-differenced):

1. `fix(window): route window-chrome IPC to the window that sent it` — `src/main/window/window-chrome-ipc-router.ts`.
   The title-bar channels (`ui:sync-traffic-lights`, `window:minimize|maximize|request-close|confirm-close`,
   `menu:popup`, `menu:topLevelItems`, `window:isMaximized`) are registered once and routed by `event.sender.id`.
   Before this, a concurrent second `createMainWindow` **threw** on the duplicate `ipcMain.handle`.
   RED proven by reverting the source only: 4/4 failed with Electron's real duplicate-handler error.
2. `fix(ipc): make renderer trust a membership, not a single id` — `src/main/ipc/app-window-renderer-registry.ts`.
   The three trusted-renderer scalars (UI / browser / clipboard) were last-writer-wins, so a second window
   silently de-trusted the first and closing the second never gave it back.

Coherence anchor: `pnpm exec vitest run --config config/vitest.config.ts src/main/ipc src/main/window`
reports **90 failed / 3218 passed / 47 skipped**. 90 is the measured pre-existing Windows baseline (git-,
symlink- and POSIX-path-dependent suites, incl. all 4 in `clipboard-file-copy.test.ts`). Any number above
90 is a regression introduced by this work.

## Active decisions

- **Invariant:** a worktree is bound to at most one window. Session state is worktree-keyed and the
  scope-merge cannot arbitrate two writers of the same key, so requesting an already-open worktree
  focuses its window. Different worktrees of one repo in separate windows is the supported case.
- **Accelerator:** `Mod+Shift+N` is currently a second alias of `workspace.create` (`src/shared/keybindings.ts:265`)
  and `keybindings-conflicts.test.ts` pins defaults to zero conflicts. Free it from `workspace.create`
  (which keeps `Mod+N`) and give it to a new `window.openNew`.
- **Menu:** File/Archivo exists only on non-macOS today; add it on macOS carrying just this item.
  New i18n key `menu.newWindow` ("Nueva ventana"), required in all 5 locales — three localization
  verifiers run inside `pnpm lint`.
- **New window boots UNBOUND** into the existing launcher (`activeView: 'workspace'`). No new picker.
- Reuse, do not rebuild: `dashboard-popout-window.ts` (per-window state, own bounds key, own partition),
  `window-bounds-validation.ts` (missing-monitor handling, already pure), `workspace-session-owner-scope.ts`
  (scope merge, complete and still unreachable from the wire).

## Next 3 actions

1. `src/main/window/attach-main-window-services.ts` has no registration latch and every sub-registrar
   does `removeHandler` first, so a second window **steals** window A's `app:reload`, `updater:*`,
   `pty:*`, `worktrees:*` and file-drop channels. Split app-global registration from window-coupled
   registration and route the window-coupled ones by sender.
2. Introduce the workspace window registry: durable window identity, renderer↔window mapping, and the
   at-most-one-window-per-worktree claim. Then key `windowBounds`/`windowMaximized` by that identity
   (they are single keys today, so two live windows trample them on every drag).
3. `OrcaRuntimeService.attachWindow` (`src/main/runtime/orca-runtime.ts:6413`) ignores a second real
   window, so window B would render with no runtime graph. Make graph authority a per-worktree claim.

## Start instruction

Read `docs/workspace-window-mode-plan.md`, then `git log --oneline -5`. Continue at action 1. Every
change lands as its own micro-commit with a RED proven before the fix, and every test run is compared
against the 90-failure baseline before anything is called a regression.
