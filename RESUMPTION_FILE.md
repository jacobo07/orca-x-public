# RESUMPTION — Orca X full-estate product solidity closure

> Everything below the `W5/W6` heading is earlier history for this branch and is still accurate
> about what it describes. This block is the current mission.

Repo: `C:\Users\User\Desktop\Cursor Projects\Vibe Coding Projects\Orca X`, branch
`orca-x/w0-durability-repros`. Session 3 ended at `85c15d6da`, having added 4 commits
(`8b93a5e0d`, `dfc7dfcf9`, `c7e111b19`, `85c15d6da`) on top of another pane's packaging work.

## Sealed 2026-09-14 (session 6) — the capability can now be negotiated

Session 5 left one software residual and named it correctly: the racy fallback was reachable
because `retireIfNoLiveWork` shipped into v35 without moving the number. **That is now measured
rather than argued.** `85c15d6da` is a real pre-atomic build — `PROTOCOL_VERSION` 35, the request
absent from all of `src/` — and a daemon built from it connects and answers
`Unknown request type: retireIfNoLiveWork`, which the client collapsed into "could not ask" and
then fell through to the pre-signal count.

Closed by the convention this file already used fourteen times: `PROTOCOL_VERSION` is **36**,
`ATOMIC_RETIREMENT_DAEMON_PROTOCOL_VERSION` is 36, 35 joins `PREVIOUS_DAEMON_PROTOCOL_VERSIONS`.
The remedy is **relocation, not repair** — the endpoint name carries the generation, so the whole
ambiguous population now sits behind its own pipe where `createLegacyDaemonAdapters` adopts it
and automatic replacement can never target it.

Two smaller defects closed with it. `killStaleDaemon` now decides from the generation **before**
asking, so an unsupported peer is refused rather than downgraded — a reply arrives too late to be
a safety mechanism. And `unsupported` and `unreachable` are no longer one value: both are
non-answers, but only one is fixed by updating a peer, and collapsing them made a daemon nobody
could connect to read as an old daemon. The caller's predicate became a positive test, because
excluding non-answers one by one meant the next one added would silently have become a live-work
refusal.

**Evidence.** `tests/e2e/daemon-version-skew-adoption.unit.test.ts` 4/4 conclusive on a real
daemon with a real live PTY: a v35 daemon is adopted and its session is still listed *by the
adopted adapter*, the current generation stays out of the adoptable population (the liveness
control), and safe replacement of a pre-boundary daemon is refused by name. Mutating the boundary
36→35 flips that last outcome from `atomic_retirement_unsupported_generation` to
`atomic_retirement_refused` — **the daemon survives in both worlds**, so an assertion on the
outcome alone would have stayed green with the negotiation severed. Byte-exact restore, SHA
verified. Composed gate 4/4 conclusive, primitive gate 3/3, typecheck 0, oxlint 0.

**The composed gate was fixed, not just re-run.** It pinned its fixture to generation 1, chosen
for isolation back when every generation answered identically — so it was proving atomic
composition in a scenario the product cannot reach. It now runs at the real generation.

**Same-scope differential, the debt session 5 left open.** `src/main/daemon` + `src/main/local-builds`,
same runner and config, at `0016eabb1`: 5 files / 10 tests failed, 1410 passed. At `6dbd58898`:
the identical 5 files and 10 tests, 1411 passed. Zero attributable new reds. The one red the
change did produce was `daemon-foreground-confirmation-protocol.test.ts` pinning the generation —
the ratchet working — and it was updated deliberately in its own commit.

**Still open, and it is software debt, not an external limit.** The Playwright
`daemon-generation-*.spec.ts` suites were not run (they need a packaged build and this host had
between 0.5 and 4 GB free all session). The identity probe still costs a `powershell.exe` spawn
under a 3 s cap; three runs this session were classified INCONCLUSIVE for it, and in production
that same degradation drops a memory-starved user into DEGRADED MODE silently.

## Sealed 2026-09-14 (session 5) — the product actually calls the daemon-side authority

Session 4 proved the atomic authority at its own boundary and refused to call W-1 complete
because nothing pinned that `killStaleDaemon` reached it. That refusal was right, and the reason
is sharper than "untested": **the composed gate could not have failed.** It asserted
`killed === false` and "daemon still alive", which BOTH guards produce — so severing the link
left every pre-existing assertion green. Measured, not argued: the mutation run's only failures
were the assertions added this session.

Closed by making the outcome say *which* guard answered. `killStaleDaemon` now returns
`preservedBy`; `'atomic_retirement_refused'` is reachable only through the daemon-side request
and is disjoint from the legacy `'live_work_admitted_after_authorization'`. The same taxonomy
lets `daemon-init` say why it enters DEGRADED MODE, which it previously could not.

**Evidence.** `tests/e2e/daemon-replacement-authorization-window.unit.test.ts` 4/4 **conclusive**
(no `identity_probe_failed`) on a real owned daemon with a real second client: live work
survives and the refusal names `reason=live_sessions`; an empty daemon still replaces
(`killed: true`) with no live-work guard firing. Mutating the LINK — not the primitive — turns
exactly the two discriminating tests red with the reason flipped to the legacy path, controls
green, tree restored byte-exact (SHA verified). `daemon-atomic-retirement.unit.test.ts` 3/3.
Typecheck 0, oxlint 0.

**Reachable residual, recorded rather than fixed.** `retireIfNoLiveWork` landed **without a
`PROTOCOL_VERSION` bump** (still 35). The pipe name is protocol-versioned, so a daemon from an
older build reporting v35 shares the endpoint, rejects the request, and is replaced under the
racy count. Worse, this is unanswerable by inspection: **a capability added without a version
boundary cannot be negotiated** — no `supports*` predicate can exist for it.
`daemon-protocol-version.ts` documents this exact hazard for `getSize` and its remedy is a
feature constant. Measured remedy: bump to 36, add `ATOMIC_RETIREMENT_DAEMON_PROTOCOL_VERSION`,
append 35 to `PREVIOUS_DAEMON_PROTOCOL_VERSIONS` — `createLegacyDaemonAdapters` **adopts**
previous-version daemons rather than replacing them, so the bump moves old daemons out of the
automatic-replacement path entirely. Deferred only because it is a wire-compatibility change
under `docs/reference/remote-wire-compatibility.md`. Interim: the downgrade now announces itself
(`reason=atomic_retirement_unsupported`); that branch is **not reachable by any test here**,
because every daemon in this repo is current code.

**Host measurement, and it is a product reading too.** The Windows identity probe spawns
`powershell.exe` under a 3 s cap. Measured at idle on 2026-09-14 with ~1–3.5 % free RAM:
median 2237 ms, worst 3106 ms, **1 failure in 6**; warm spawns cost the same as cold, so
warming is not a mitigation. Two of five composed runs were INCONCLUSIVE for this reason — never
"safe". In production the same degradation sends automatic replacement to
`identity_probe_failed` → preserve → DEGRADED MODE, i.e. a memory-starved user silently loses
daemon persistence. Not filed as a wave; recorded as a candidate.

One harness fault classified: a run where test 1 died on `EPERM` creating its temp dir never
terminated its daemon, so tests 2–4 all failed `EADDRINUSE` on the pipe. Cascade from one
fixture fault; zero leftover fixture daemons afterwards. Verifier failure, not subject failure.

## Sealed 2026-09-14 (session 4) — the destruction decision now belongs to the daemon

**Session 3's fix narrowed the window and the residual was still destructive.** Measured by
positioning a real second client between the real count RESOLVING and `process.kill`: the guard
acted on a true count of 0, a session was admitted after it, and the daemon was killed. So the
residual was never an external limit — **a peer that answers a socket CAN make this atomic, because
it is the peer**. `daemon-server.ts` already said so twice in its own comments.

`shutdownIfIdle` could not be reused: it also demands the caller be the daemon's **only** client,
which is right for quit and wrong for replacement — an attached second window is exactly when a
stale empty daemon must still be replaced. New request `retireIfNoLiveWork`: the same emptiness
proof minus sole-client, committing to `shutting-down` in the **same event-loop turn**, so the proof
and the admission fence are one event. A new method NAME, not a new optional field, so an old daemon
throws `Unknown request type` and mixed versions fail closed; `'unsupported'` is deliberately
distinct from a refusal and falls back to the (still racy, now legacy-only) count path.

Gate: `tests/e2e/daemon-atomic-retirement.unit.test.ts`, 3/3 — empty retires (negative control),
live session refuses, and **a daemon that agreed to retire refuses the next create**. Mutation:
remove the fence while still replying `retiring: true` → the fence test goes red and the reply-only
control stays green. Deliberately narrow: it never enters `killStaleDaemon`, so it spawns no Windows
process-identity query, which needs a subprocess inside 3s and misses when the host is short of
memory.

**Owed:** the end-to-end gate through `killStaleDaemon` is INCONCLUSIVE on this host (4% free RAM →
the identity probe degrades to `unknown`), so **that `killStaleDaemon` calls the new request is
not yet pinned by a test**. Re-run `daemon-replacement-authorization-window.unit.test.ts` with
headroom and assert the refusal warning names `reason=live_sessions`.

## Sealed 2026-09-13 (session 3) — the destruction authority now outlives its own evidence check

**The 592 ms window was enterable and destructive.** Against a real owned daemon, a second real
client admitted a session through the production `createOrAttach` route while the destruction was
in flight, and that session was killed. The daemon's admission fence could not help: it is keyed to
`idleShutdownState`, which belongs to *self*-retirement, and a client-driven kill never sets it — so
the fence is open for the whole window by construction. **Two authorities, one fence.**

Why no test had seen it: every unit test of the replacement decision declares
`vi.mock('./daemon-stale-kill')`, so the race sat exactly in the span the double replaced.

Closed by re-taking the count immediately before the signal, from a new shared
`daemon-live-session-count.ts` rather than a second copy. **Opt-in** (`preserveLiveWork`): restart
and quit reach the same primitive via `cleanupDaemonForProtocol`, and that refusal there would make
a wedged daemon unkillable after the user asked for it. Only a positive count refuses; `null`
proceeds, because unknown is the #8689 question already answered upstream by the grace-retry budget.
Mutation-proven in both directions (remove the guard → the two safety cases red; make it refuse on
unknown → only the unknown control red). **Narrowed to one round trip, not closed** — nothing makes
a check and a signal atomic against a peer answering a socket.

Gate: `tests/e2e/daemon-replacement-authorization-window.unit.test.ts`, 4/4, a Vitest file (not
Playwright — `tests/e2e/**/*.unit.test.ts` is in the main vitest project). Fixture traps that each
return a confident wrong answer are in memory `orca-daemon-generation-fixture-recipe`.

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
`Get-CimInstance` spawn — **median 592 ms, range 522–835** over five runs on this host. **Closed in
session 3 — see the block above.** Full account: memory
`orca-daemon-destructive-authority-is-already-built`.

Still open in that file, found while closing the above and deliberately NOT changed: after a
*confirmed* kill, the tail endpoint probe is connect-only, and on Windows a just-killed daemon's
named pipe still accepts a connect for a short window (measured 1 of 3 runs), so `killStaleDaemon`
can report `liveOwnerSurvived: true` for a daemon it proved dead — which costs the user a daemon for
that launch. It cannot be fixed by ranking a confirmed exit above the probe: `daemon-health.test.ts`
pins that same `true` for a real handover, where a replacement daemon took the endpoint during the
kill. Separating a remnant from a live successor needs a protocol round trip.

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
