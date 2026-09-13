# RESUMPTION — Orca X full-estate product solidity closure

> Everything below the `W5/W6` heading is earlier history for this branch and is still accurate
> about what it describes. This block is the current mission.

Repo: `C:\Users\User\Desktop\Cursor Projects\Vibe Coding Projects\Orca X`, branch
`orca-x/w0-durability-repros`, HEAD `17cb2838c` (session 2 added 3 commits from `da5c005e9`).

## Sealed 2026-09-13 (session 2) — the claim-to-evidence pointer is now dereferenced

`b210c98f2` pinned the hole, `15f4adf5f` closed it, `17cb2838c` wrote the contract down. The checker
now resolves every `assertionRefs` string against the source it cites, ratcheted through
`config/reliability-assertion-baseline.txt` (67 gates frozen with counts; counts may only shrink; a
gate absent from the list must resolve everything; an entry whose gate now resolves is REFUSED so the
list cannot outlive its debt; `--prune` rewrites downward and refuses to record anything new).
**92 gates still CONTRACT VALID — nothing turned red.** Six drills on a synthetic gate, green half
included. Checker runtime ~1s (was 49.8s before whole-file normalization was measured and removed —
it rescued zero assertions).

The 55 were NOT stale. They are faithful paraphrases of real tests. Both conventions appear in
`5b5ce6cef`, the commit that introduced the field, and `git log -S` with a working control proves the
non-matching strings never existed in source. Four shapes; three cannot be reworded (a claim merging
several `it()` blocks, an `it.each` generated title, a paraphrase sharing no tokens).

## W-1 daemon safety — the inherited premise was wrong; read this before planning it

`src/main/daemon/` is ~150 files and already implements three-state process evidence
(present/gone/unknown + reasons + evidence sources), live-session gating before replacement,
pid-recycle recheck between SIGTERM and SIGKILL, confirmed-kill, incarnation-fenced pid unlink, and
degraded adoption instead of forking beside an unprovable daemon. **An atomic idle admission fence
EXISTS and was never rejected** (`daemon-idle-shutdown.test.ts`, 28 tests, #9277/#12882) — it rejects
create/attach once shutdown is pending and aborts shutdown for a create that started before the
fence. Wrong-owner fallback routing is already closed in `degraded-daemon-session-routing.ts`.

The one open gap, measured: between the last live-session observation and SIGTERM sits a Windows
`Get-CimInstance` spawn — **median 592 ms, range 522–835** over five runs on this host. Nothing
re-authorizes inside it and no test drives a session appearing there. Full account: memory
`orca-daemon-destructive-authority-is-already-built`.

## Sealed 2026-09-13 — the taskbar takeover is state-scoped

`start()` forced the iconic representation for the window's whole life, so DWM stopped compositing
Orca's own surface at attach and did not resume until close. A supplied bitmap is capped at the size
the shell asks for, so while the window is VISIBLE the takeover bought nothing and cost resolution.
Now: minimized engages, restore releases, already-minimized engages at start. No native rebuild —
the addon already took the flag and its docstring already said "Called on restore".

Proven at the OS boundary and differentially: a build with the fix reported thumbnail source
**1927x1142 visible / 250x148 minimized**, while the still-running older install reported 250x148
**not minimized** in the same two samples, beside five unrelated windows at their real rect.
Registered as gate `window-representation.a-takeover-must-beat-the-default-it-displaces` (92 gates,
CONTRACT VALID).

## The three registries are the Product Solidity Ledger — do not build a fourth

`reliability-gates.jsonc` (claims, 92), `durability-contracts.jsonc` (what a write owes, 13 + 19 + 38
grandfathered), `variant-parity.jsonc` (cross-variant inheritance; unresolved=4, all measured-open,
release-critical=0). All three green at HEAD. `variant-parity.jsonc` already implements
"knowing more is not the same as having built it" in its own prose.

## Measured, open, and the highest-ROI next action

**The claim registry never opens the file it cites.** `validateAssertionRef` checks `ref.file` is in
`testFiles` and that `assertions` is a non-empty string array — it never reads the file. Swept all 92
gates with absent- and present-string controls: **everyAssertionFound=12, someFound=12,
noneFound=55, noAssertionRefs=13**. Bimodal (0/30, 0/40, 0/49, never partial), so it is two
conventions in one field, not drift. One cited file's only test is `test.skipIf(...)` with a
generated title, i.e. evidence gated off by default. Do NOT add a literal-match check — 55 gates go
red and the gate gets disabled. Ratchet it, with a synthetic subject for the red branch. Full
account: memory `trap-a-claim-registry-that-never-opens-the-file-it-cites`.

**The packaged taskbar gate still cannot judge its subject.** `app.asar`'s entry for
`out/main/index.js` differs from the built one at an identical length. That is a verifier failure,
not a subject failure, and it is recorded as a knownGap on the new gate.

## Running things here, learned this session

- A `Start-Process` child does NOT survive the end of a tool call. Launch, measure and tear down
  inside ONE invocation.
- `ORCA_USER_DATA_PATH=<temp>` gives an independent instance despite the single-instance lock, so a
  second Orca can be measured without disturbing the user's running one.
- `pnpm exec` is mangled by the RTK hook here — use `node node_modules/vitest/vitest.mjs`.
- oxlint prints nothing when clean; drive a synthetic offender before trusting an empty exit 0.

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

## Workspace chrome & navigation convergence (started 2026-09-05)

Spec of record: `docs/workspace-chrome-navigation-convergence-spec.md` (untracked, like its siblings).

**Sealed.** Contextual window identity, production-verified:
- `6a760673e` — `shared/window-identity-title.ts` (pure, 6/6) + `app-shell/use-window-identity-title.ts`.
  Project leads, brand trails, worktree joins only when it differs from the repo.
- `ff77532c9` — the derivation keyed off `activeRepoId`, which is **null on a bound window**; the
  repo now resolves through the active worktree's `repoId`. Caught only by launching the app.
  `tests/e2e/window-project-identity-title.spec.ts` asserts `BrowserWindow.getTitle()` and passes.
  Observed: `orca-e2e-repo-wrcROW — master — Orca X`.

**Measured, correcting likely assumptions:**
- `hooks/useSidebarResize.ts` is **already live** (rAF + direct DOM width, store commit on mouseup).
  Do not rebuild it; find the consumer that reads the release-only store value.
- `app-shell/use-persisted-ui-writer.ts` persists sidebar/panel/activeView **profile-globally** —
  an undeclared cross-window channel after W6. Classify scope before adding navigation state.
- `AppWorkspaceShell.tsx:78-93` mounts non-`terminal` views *instead of* the workspace, so an
  activity switch is a conditional unmount by design. Both sidebar and shell error boundaries carry
  `resetKey={activeView}`.
- `SidebarNav.tsx` holds the global rows (Tasks/Automations/Workspace/Mobile/Artifacts/Skills/Agents).
  `SidebarTaskNavButton` carries four per-provider hover shortcuts that a 40px icon cannot hold —
  the rail migration must relocate them, not drop them.
- Projects/Files convergence already shipped (`right-sidebar/left-nav-projects-switch.tsx`); its
  switch is pure presentation (`toggleRightSidebar` has no semantic side effect).

**Baseline for these suites** (measured 2026-09-05, `_logs/baseline-nav-20260905-231600.log`):
`components/sidebar components/right-sidebar hooks/useSidebarResize store/slices app-shell` =
**2 failed / 6684**, both in `right-sidebar/SourceControl*`, untouched by this work.

**Sealed 2026-09-06 — the rail and everything that hung off it.**

- `8eb07139f` application surfaces get their own section of the **existing** far-left rail
  (`right-sidebar/index.tsx` already renders a 40px side strip when `activityBarLeads`; defaults are
  `sidePanelDock: 'left'` + `activityBarPosition: 'side'`). New: `components/activity-rail/`.
- `ec0a87a36` capability relocation. Tasks' four provider shortcuts (hover-only before) move to a
  context menu; `hooks/useVisibleTaskProviders.ts` is the one resolution both surfaces share. Every
  row's "Hide from sidebar" and both badges (Agents unread, Mobile "New") relocated too.
- `e67a37927` rows removed, `SidebarTaskNavButton` deleted (−887/+298). Tour anchors checked against
  `shared/contextual-tours.ts` first: neither is referenced.
- `6ccaa7233` e2e: rail is real, and Automations→back preserves **tab identity** (surface isolation).
- `b2b499b85` e2e: icon-only collapse. **No code change was needed** — see below.
- `9dbbc336e` unit: drives the `'sync'` branch that keeps `activeView` window-local.

**Three things that already existed and must not be rebuilt:**
1. The far-left vertical rail (it just carried nothing worth keeping until the surfaces moved in).
2. Icon-only collapse — `closedWidth: activityBarLeads ? activityBarSideWidth : 0`.
3. `activeView` window-scoping on `'sync'` hydration (guard existed; nothing had tested it).

**Packaged reality (2026-09-06, HEAD 9dbbc336e):** built via the BuildTools
`vcvars64.bat`; `dist/orca-x-windows-setup.exe` 188 MB. Verified by **content**, not timestamp — the
packaged `app.asar` contains `data-workspace-activity-rail`, `data-workspace-activity-tasks` and
`buildWindowIdentityTitle`. Note `dist/orca-windows-setup.exe` (19/08, upstream-named) is stale and
sitting beside it.

**Still open:**
- **Live-resize consumer: UNMEASURED, not cleared.** A synthetic drag left the handle at the same x
  (`handleX 314 -> 314`), so the run carried no information; the harness was deleted rather than
  weakened. Next instrument is a different shape: assert the handle's `bg-ring` class right after
  `mouse.down()` to separate "press never landed" from "consumers ignore it".
- `sidebarWidth` and `rightSidebarOpen` still ride the cross-window sync broadcast unguarded.
- The dashboard pop-out entry still lives in the sidebar (it opens a window, not a view).
- Redundant-control consolidation beyond the row removal.

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

## Found while shipping, not caused by this branch

- **A main process can survive with no window, no renderer and no tray.** Measured 2026-09-04: one
  `Orca X.exe`, 2 MB, zero children, no window handle, days old — and it blocked the NSIS installer
  with "close the application manually" when there was nothing to close. The profile log ends
  mid-normal-operation with **no** `crash.breadcrumb` for process-gone, recovery or quit, and that
  file can hold them (three exist earlier in it), so the recovery path is *not* evidenced as the
  cause. **Cause remains unestablished.**
  Fixed in `4c37af785`: `presentRendererRecoveryPrompt` acted only when Reload was chosen *and* a
  live window existed, so Reload-with-the-window-gone fell past both branches and did nothing —
  a different route to the same state. The decision is now a total function and both exits leave a
  breadcrumb. Detection is automated in `~/.claude/hooks/orphan-dev-server-reaper.ps1`.

- **The installed app was a MIXED build, which is why New Window looked missing.** Measured
  2026-09-04: `Orca X.exe` is byte-identical to `dist\win-unpacked`, `resources\app.asar` is the
  08/24 one, and the other 3281 files match. Electron memory-maps the asar, so the husk above held
  the single file carrying all application code; NSIS could not overwrite it and reported success
  regardless. The feature is correct in source (`menu/register-app-menu.ts:177`) and present in the
  built asar; it was absent only from the installed one. Repair and future detection:
  `~\.claude\bin\verify-electron-install.ps1 -Built dist\win-unpacked -Installed <root> [-Repair]`
  (self-test 5/5; refuses to repair while a process runs from the install root).

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
