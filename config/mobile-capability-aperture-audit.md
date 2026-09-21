# Mobile capability audit: the full desktop RPC surface

## What this measures

`config/variant-parity.jsonc` tracks 19 capabilities someone thought to ask about. That is a
drift registry, not an inventory, so its "4 open" total says nothing about the surface nobody
entered. This audit supplies the missing denominator.

The population is every `defineMethod({ name: ... })` declaration under
`src/main/runtime/rpc/methods/`, enumerated structurally. The allowlist was never used to find
it — grepping for a gate finds the members that have it, which is the opposite of the question.

**Positive control:** all 260 allowlisted methods were found in the independently-enumerated
population (0 unaccounted), so the extractor has no hole on the side we can check.

## Numbers

| | |
|---|---:|
| host RPC methods (population) | **565** |
| reachable from mobile (`MOBILE_RPC_METHOD_ALLOWLIST`) | **260** |
| host-only | **305** |
| mobile reach | **46.0%** |

Enforced at `src/main/runtime/runtime-rpc.ts:1685` — a mobile-scope device calling anything
outside the allowlist is refused with `forbidden`.

## Proposed disposition tally

| disposition | methods |
|---|---:|
| measured-open | 270 |
| desktop-only | 19 |
| not-applicable | 16 |

> These are **proposals** derived from namespace semantics and method names. A row entering the
> gate-enforced registry needs per-row evidence; `measured-open` additionally needs a statement
> of what remains and what closes it.

## Governance consequence — read before filing these

`unknownPolicy` and `measuredOpenPolicy` are both `ratchet`, and both baselines may only
SHRINK. So these gaps **cannot simply be poured into the registry**: every new `measured-open`
or `unknown` row fails the gate by design. That is the registry working — new debt cannot be
created silently. Three legitimate routes:

1. File the `not-applicable` / `desktop-only` rows now — they need only a `reason` and pass.
2. Close a gap, then file it as `ported` with evidence.
3. Deliberately extend a baseline — a decision that shows up in a diff and needs an argument.

## What would close the largest gaps

Ordered by user-visible consequence rather than method count:

| gap | consequence today | what closes it |
|---|---|---|
| `files.*` writes | Mobile is structurally **read-only on the filesystem** — it can open and preview but never edit, rename or delete. | Allowlist the write methods behind the same observed-state precondition `git.discard` already carries. |
| `jira.*` | A Jira shop has no issue workflow on mobile at all, while Linear, GitHub and GitLab users do. | Allowlist the 23 methods; mobile already renders the other three trackers. |
| `repo.*` + `projectHostSetup.*` | A user cannot clone, create or adopt a project from the phone — only operate one that already exists. | Allowlist create/clone/add; they are host-side operations mobile can request. |
| `orchestration.*` | Orchestrated agent work can be observed on the tasks screen but never driven, replied to, or stopped. | Largest of the four; needs a mobile surface, not just an allowlist entry. |

Each is an **allowlist decision plus a mobile surface**, not a port: the host already
implements every one of these methods, and mobile already speaks the wire that carries them.

## Classification

A namespace appears more than once when its methods split across dispositions — `terminal.*`
divides into pane geometry that has no mobile meaning and lifecycle calls that do.

### `browser.*` — measured-open (P2) — 65 methods

Mobile drives basic navigation and input (17 methods) but not the automation suite: eval, snapshot, network, cookies, storage, profiles, interception, upload/download, PDF and screenshot. A mobile user can browse but cannot inspect or automate.

`browser.capture.start`, `browser.capture.stop`, `browser.certificate.proceed`, `browser.check`, `browser.clear`, `browser.click`, `browser.clipboardRead`, `browser.clipboardWrite`, `browser.console`, `browser.cookie.delete`, `browser.cookie.get`, `browser.cookie.set`, `browser.dblclick`, `browser.download`, `browser.drag`, `browser.eval`, `browser.exec`, `browser.fill`, `browser.find`, `browser.focus`, `browser.fullScreenshot`, `browser.geolocation`, `browser.get`, `browser.highlight`, `browser.hover`, `browser.intercept.disable`, `browser.intercept.enable`, `browser.intercept.list`, `browser.is`, `browser.network`, `browser.pdf`, `browser.profileClearDefaultCookies`, `browser.profileCreate`, `browser.profileDelete`, `browser.profileDetectBrowsers`, `browser.profileImportFromBrowser`, `browser.profileList`, `browser.screenshot`, `browser.scroll`, `browser.scrollIntoView`, `browser.select`, `browser.selectAll`, `browser.setCredentials`, `browser.setDevice`, `browser.setHeaders`, `browser.setMedia`, `browser.setOffline`, `browser.snapshot`, `browser.storage.local.clear`, `browser.storage.local.get`, `browser.storage.local.set`, `browser.storage.session.clear`, `browser.storage.session.get`, `browser.storage.session.set`, `browser.tabClose`, `browser.tabCurrent`, `browser.tabList`, `browser.tabProfileClone`, `browser.tabProfileShow`, `browser.tabSetProfile`, `browser.tabShow`, `browser.tabSwitch`, `browser.type`, `browser.upload`, `browser.wait`

### `orchestration.*` — measured-open (P1) — 38 methods

Agent orchestration: runs, workers, tasks, gates, federation, inbox/reply. Mobile has a tasks route and agentTeams (2 methods) but none of the 38 orchestration methods, so orchestrated work can be observed but not driven from mobile.

`orchestration.ask`, `orchestration.check`, `orchestration.dispatch`, `orchestration.dispatchShow`, `orchestration.federationAck`, `orchestration.federationAttachStart`, `orchestration.federationImport`, `orchestration.federationPull`, `orchestration.federationRead`, `orchestration.federationReadOutput`, `orchestration.federationShow`, `orchestration.federationStop`, `orchestration.gateCreate`, `orchestration.gateList`, `orchestration.gateResolve`, `orchestration.inbox`, `orchestration.reply`, `orchestration.reset`, `orchestration.run`, `orchestration.runCreate`, `orchestration.runCurrent`, `orchestration.runList`, `orchestration.runShow`, `orchestration.runStop`, `orchestration.runUse`, `orchestration.send`, `orchestration.taskCreate`, `orchestration.taskList`, `orchestration.taskUpdate`, `orchestration.workerAbandon`, `orchestration.workerList`, `orchestration.workerRead`, `orchestration.workerRelease`, `orchestration.workerRetain`, `orchestration.workerShow`, `orchestration.workerStart`, `orchestration.workerStop`, `orchestration.workerTerminalUserInput`

### `jira.*` — measured-open (P1) — 23 methods

Mobile reaches Linear (26), GitHub (43) and GitLab (12) but zero Jira methods. Mobile supports three of the four trackers the host supports, so a Jira-shop user loses issue workflow entirely on mobile.

`jira.addIssueComment`, `jira.connect`, `jira.createIssue`, `jira.disconnect`, `jira.getIssue`, `jira.getIssueStream`, `jira.getProjectStatusOrder`, `jira.issueComments`, `jira.issueCommentsStream`, `jira.listAssignableUsers`, `jira.listCreateFields`, `jira.listIssueTypes`, `jira.listIssues`, `jira.listPriorities`, `jira.listProjects`, `jira.listTransitions`, `jira.lookupIssueSummary`, `jira.readStatus`, `jira.searchIssues`, `jira.selectSite`, `jira.status`, `jira.testConnection`, `jira.updateIssue`

### `emulator.*` — desktop-only (P3) — 19 methods

The emulator pane runs an Android/iOS emulator on the developer machine. A phone cannot host one, and driving a remote emulator from a phone duplicates what the phone already is.

`emulator.attach`, `emulator.availability`, `emulator.ax`, `emulator.button`, `emulator.exec`, `emulator.gesture`, `emulator.install`, `emulator.kill`, `emulator.launch`, `emulator.list`, `emulator.listDevices`, `emulator.listSimulators`, `emulator.logcat`, `emulator.permissions`, `emulator.rotate`, `emulator.shutdown`, `emulator.tap`, `emulator.type`, `emulator.unregisterActive`

### `computer.*` — measured-open (P2) — 15 methods

Computer-use control of the host desktop (click, drag, hotkey, window list). Technically expressible from mobile as a remote controller, but it is a high-blast-radius surface that should be an explicit owner decision rather than an oversight.

`computer.capabilities`, `computer.click`, `computer.drag`, `computer.getAppState`, `computer.hotkey`, `computer.listApps`, `computer.listWindows`, `computer.pasteText`, `computer.performSecondaryAction`, `computer.permissions`, `computer.permissionsStatus`, `computer.pressKey`, `computer.scroll`, `computer.setValue`, `computer.typeText`

### `files.*` — measured-open (P1) — 15 methods

Mobile reads the filesystem (14 methods) but holds no write path: write, copy, rename, delete, createDir, search, stat and watch are all host-only. Mobile is structurally read-only on files.

`files.commitUpload`, `files.copy`, `files.createDir`, `files.createDirNoClobber`, `files.delete`, `files.listAll`, `files.listMarkdownDocuments`, `files.rename`, `files.search`, `files.stat`, `files.unwatch`, `files.watch`, `files.write`, `files.writeBase64`, `files.writeBase64Chunk`

### `linear.*` — measured-open (P2) — 15 methods

Mobile reaches 26 of 41 linear methods; the remainder need per-method review.

`linear.agentIssueList`, `linear.agentProjectList`, `linear.agentTeamLabels`, `linear.agentTeamList`, `linear.agentTeamMembers`, `linear.agentTeamStates`, `linear.disconnect`, `linear.issueAddComment`, `linear.issueAttachLink`, `linear.issueCreate`, `linear.issueRelationWrite`, `linear.issueSetState`, `linear.issueUpdateTask`, `linear.saveIssue`, `linear.testConnection`

### `skills.*` — measured-open (P2) — 13 methods

Skill discovery, install and share. No mobile reach; a user cannot install or manage skills from the phone.

`skills.beginUpload`, `skills.cancelInstall`, `skills.cancelUpload`, `skills.commitUpload`, `skills.discover`, `skills.getInstallProgress`, `skills.install`, `skills.installBundle`, `skills.listManagedInstalls`, `skills.previewInstall`, `skills.removeInstall`, `skills.share`, `skills.uploadChunk`

### `repo.*` — measured-open (P1) — 11 methods

Add, clone, create, remove and reorder repositories. Mobile can operate an existing repo but cannot acquire one.

`repo.add`, `repo.clone`, `repo.create`, `repo.hooksCheck`, `repo.issueCommandRead`, `repo.issueCommandWrite`, `repo.reorder`, `repo.rm`, `repo.setBaseRef`, `repo.setupScriptImports`, `repo.show`

### `gitlab.*` — measured-open (P2) — 9 methods

Mobile reaches 12 of 21 gitlab methods; the remainder need per-method review.

`gitlab.addMRInlineComment`, `gitlab.diagnoseAuth`, `gitlab.jobTrace`, `gitlab.listIssues`, `gitlab.listLabels`, `gitlab.listMRs`, `gitlab.rateLimit`, `gitlab.retryJob`, `gitlab.updateMRReviewers`

### `terminal.*` — not-applicable — 8 methods

Desktop pane geometry and multi-pane layout. Mobile presents one terminal at a time and has no split/pane model.

`terminal.getDisplayMode`, `terminal.recoverPane`, `terminal.resizeForClient`, `terminal.resolveActive`, `terminal.resolvePane`, `terminal.restoreFit`, `terminal.show`, `terminal.split`

### `artifacts.*` — measured-open (P2) — 7 methods

Artifact publish/share/list. Viewing and sharing an artifact is a natural mobile action and is entirely unreachable.

`artifacts.delete`, `artifacts.getPublishedLink`, `artifacts.list`, `artifacts.publish`, `artifacts.share`, `artifacts.unshare`, `artifacts.update`

### `automation.*` — measured-open (P2) — 7 methods

Scheduled automation CRUD and run-now. Checking or triggering an automation from a phone is a natural mobile action.

`automation.create`, `automation.delete`, `automation.list`, `automation.runNow`, `automation.runs`, `automation.show`, `automation.update`

### `git.*` — measured-open (P2) — 6 methods

Mobile reaches 29 of 35 git methods; the remainder need per-method review.

`git.bulkDiscard`, `git.checkIgnored`, `git.conflictOperation`, `git.remoteCommitUrl`, `git.remoteFileUrl`, `git.submoduleStatus`

### `github.*` — measured-open (P2) — 6 methods

Mobile reaches 43 of 49 github methods; the remainder need per-method review.

`github.issue`, `github.listIssues`, `github.prComments`, `github.rateLimit`, `github.repoUpstream`, `github.setPRCommentReaction`

### `projectGroup.*` — measured-open (P2) — 6 methods

Mobile reads project groups but cannot create, update, delete, move or import nested projects.

`projectGroup.create`, `projectGroup.delete`, `projectGroup.importNested`, `projectGroup.moveProject`, `projectGroup.scanNested`, `projectGroup.update`

### `projectHostSetup.*` — measured-open (P1) — 6 methods

Clone, create, delete and adopt a project on the host. A user cannot start or onboard a project from mobile at all.

`projectHostSetup.clone`, `projectHostSetup.create`, `projectHostSetup.delete`, `projectHostSetup.list`, `projectHostSetup.setupExistingFolder`, `projectHostSetup.update`

### `worktree.*` — measured-open (P2) — 5 methods

Mobile reaches 12 worktree methods but not list/detectedList/lineageList/persistSortOrder. Worth verifying whether mobile obtains listings through status.get instead, in which case this is equivalent rather than open.

`worktree.detectedList`, `worktree.lineageList`, `worktree.list`, `worktree.persistSortOrder`, `worktree.teardownMissingTerminals`

### `accounts.*` — measured-open (P2) — 4 methods

Mobile selects and lists accounts but cannot add or remove a Claude/Codex account.

`accounts.addClaudeFromConfigDir`, `accounts.addCodexFromHome`, `accounts.removeClaude`, `accounts.removeCodex`

### `folderWorkspace.*` — measured-open (P2) — 4 methods

Mobile lists folder workspaces but cannot create, update or delete them.

`folderWorkspace.create`, `folderWorkspace.delete`, `folderWorkspace.getPathStatus`, `folderWorkspace.update`

### `plugins.*` — measured-open (P2) — 4 methods

Plugin list, consent, enable and command invocation. Panel-bound methods are separately not-applicable.

`plugins.consent`, `plugins.invokeCommand`, `plugins.list`, `plugins.setEnabled`

### `terminal.*` — measured-open (P2) — 4 methods

Lifecycle and introspection beyond the pane-geometry methods: stop, stopExact, sleep, inspectProcess.

`terminal.inspectProcess`, `terminal.sleep`, `terminal.stop`, `terminal.stopExact`

### `updater.*` — not-applicable (P3) — 4 methods

Electron self-update. Mobile updates through the app store, so the capability has no mobile expression.

`updater.check`, `updater.download`, `updater.getStatus`, `updater.install`

### `plugins.*` — not-applicable — 2 methods

Drives a desktop plugin panel surface that mobile does not render.

`plugins.panelAction`, `plugins.readPanelEntry`

### `project.*` — measured-open (P2) — 2 methods

project.list/update. Mobile reaches projectGroup.list and folderWorkspace.list but not the project registry itself.

`project.list`, `project.update`

### `workspacePorts.*` — measured-open (P2) — 2 methods

Scan and kill dev-server ports. Reading what is listening is a natural mobile diagnostic.

`workspacePorts.kill`, `workspacePorts.scan`

### `preflight.*` — not-applicable — 1 method

Host-side capability probe consumed by desktop terminal setup.

`preflight.detectRemoteWindowsTerminalCapabilities`

### `preflight.*` — measured-open (P3) — 1 method

preflight.refreshAgents unavailable to mobile.

`preflight.refreshAgents`

### `session.*` — measured-open (P3) — 1 method

session.tabs.setTabProps — tab property writes unavailable to mobile.

`session.tabs.setTabProps`

### `session.*` — not-applicable — 1 method

Pane layout is a desktop windowing concept; mobile has no pane grid.

`session.tabs.updatePaneLayout`

### `settings.*` — measured-open (P3) — 1 method

A settings write mobile cannot perform; mobile reads settings but cannot set this override.

`settings.updatePRBotAuthorOverride`

## Keeping this honest

`pnpm check:mobile-aperture` re-derives these numbers and fails when a NEW host-only method
lands unbaselined, so the next one is a decision somebody makes in a diff. The frozen set is
`config/mobile-capability-aperture-baseline.txt` and may only shrink, in both directions —
a method that becomes reachable, or that stops existing, fails as a stale exception.

The gate ships with `config/scripts/check-mobile-capability-aperture.test.mjs`, which drives
every red branch against synthetic subjects, keeps a green control beside them, and asserts
the CLI actually prints a verdict — it shipped once with an entry-point check that silently
never ran, which exits 0 and reads exactly like a pass.

## Not measured here

This audit covers the **RPC wire** — what mobile may ask a host to do. It does not cover
desktop capability that never crosses the wire at all: window management, native menus,
packaging and update flows, taskbar integration, multi-window behaviour. Those are
desktop-only by construction and are not counted in the 565.

It also does not measure **surface**. A method being allowlisted means mobile may call it,
not that any screen does. Reach is an upper bound on capability, never evidence of it.
