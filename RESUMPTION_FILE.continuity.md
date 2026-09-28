# RESUMPTION — Orca X Continuity / Resume Center (worktree `C:\Users\User\Apps\orca-continuity-wt`)

## 1. Identity
Branch `orca-x/continuity-resume-center` from `orca-x/integration` @ `a3445471e` (2026-09-28). Spec (read
first): `docs/reference/continuity-resume-center.md`. Visual target: Owner image
`C:\Users\User\Downloads\Imagen de ChatGPT 28 sept 2026, 13_50_23.png` (Resume Center, es). Thesis: the
desk is already durable; show it, restore it without waking, resume it at the host's pace.
node_modules = junction to the main checkout (never `pnpm install`). This branch's `RESUMPTION_FILE.md` is
inherited from other programs — never edit it.

## 2. Owner decisions (2026-09-28)
D1 a BLUE control beside "Create snapshot" chooses dormant (= Park & Exit at close) or active (warm quit).
D2 multi-workspace desk snapshots. D3 Cursor hook entry allowed; Open in Cursor only. D4 Park & Exit
multi-window. D5 paced resume by measured headroom, queued never dropped.

## 3. Audit (23 gaps, 7 blockers) — all folded into the spec
Evidence: scratchpad `continuity-audit.md` (session 2aad6d8e). Load-bearing facts: ordinary quit keeps the
daemon warm and relaunch REATTACHES (never gate it); local scrollback lives in daemon history, not refs;
no quit-time capture slot (thumbnails composed from previews); working-set apply needs an EMPTY target;
a window owns exactly its binding; Cursor hook service already exists (extend, authenticated endpoint);
headroom owner = `observeDispatchHostResources`; surface-claims gate sees only `ContextRow` in listed roots.

## 4. Phases (commit per fact; GEX44 for suites)
P1 desk projection (pure, shared) + characterization of reattach vs spawn by ptyId.
P1b main read IPC (partitions + topology + live list; remote = live|not-live|unknown).
P2 previews (HeadlessEmulator from daemon history / session ref / sealed working set).
P3 Resume Center surface + surface-claims gate extension.
P4 wake admission (token contract, event-driven) + Restore layout only + Resume / Resume all.
P5 Park & Exit multi-window + D1 blue control. P6 desk snapshots (+ retention, delete order).
P7 Cursor bridge. P8 real-app proof, mutations, perf, KV/UKDL, continuity ratchet.

## 5. State
- DONE: spec `8918ba792`; P1 projection `8c7db1f49` (12 tests, 5/5 mutations); P1b
  `continuity:readDesk` `919391fe9` (main `src/main/continuity/desk-read.ts`, preload + web 'unavailable';
  5 tests, 3/3 mutations). tsc node/tc.web/tc.cli 0.
- DONE P2 `552dc32f4` `continuity:renderPanePreview` (main `src/main/continuity/pane-preview.ts`,
  caller names a pane; daemon history with ignoreCleanEnd / session ref; 7 tests, 6/6 mutations).
- DONE P3a `22f49f14d` surface-claims gate reads `ClaimValue` too.
- DONE P3 `a78bd9d99`: Resume Center view (`resumeCenter` TopLevelView, entry = History icon beside New
  agent in CognitiveWorkspaceRoster, breadcrumb back), components in
  `src/renderer/src/components/resume-center/`, 49 keys x5 locales, 10 ClaimValues classified, presenter
  `ContinuityTone` registered, runtime client-ui-schemas accepts 'resumeCenter'. lint 0, tsc 0/0/0, surface
  gate green (28 sites), 47 continuity tests. verify:localization-catalog red ONLY on pre-existing
  terminalPreview.* keys in TerminalPreviewCard.tsx (not ours).
- DONE P3 proof `837e047ff`+`d021f34a3`: e2e `tests/e2e/resume-center.spec.ts` GREEN on GEX44 at
  d021f34a3 (1 passed, 40.6 s; worktree /home/kobii/rc-e2e, build --mode e2e). Two live tabs print
  node-concatenated markers; both rows read `warm`; each expanded row's daemon-history snapshot holds
  its own marker and not its sibling's. Red drill (GEX44, same commit): every pane resolved from the
  first tab (findTab ignores the id + per-leaf ptyId lookup off) -> RED "the RCB row never showed its
  own recorded screen" (rendered, wrong screen). A findTab-only mutant SURVIVED and is equivalent: with
  a leaf id the session comes from the requested tab's layout; `tab.ptyId` is only the leafless
  fallback. Localization extraction: 133 missing keys, NONE resumeCenter
  (90 workspace, 17 agents, 15 conversations, 7 terminalPreview, 3 auto, 1 activity — other programs).
- P4 (2026-09-28, Owner answers Q1-6: provisional 4 GB floor; SSH/WSL refused in Resume all, allowed
  alone as "not measured"; Continue button, no polling; orphans shown; Open = layout only; Windows
  proof of restore->zero wake required). Commits 8fab83831 (RED e2e) 458e9de54 562b3d118 9e34ae6b1
  f0434b7e0 d24fc6625 ed7039b3e f51571840 1b5318870 85a554b49 1bb84fff0.
  - PROVEN GEX44 @85a554b49: resume-center-restore-no-wake (RED before fix at 8fab83831: a host session
    started), resume-center-resume (restore 0 / Resume A +1 own / Resume all B woken, C refused / Continue
    0), P3 spec: 3 passed. Gate @f51571840: lint 0, tsc 0/0/0, vitest 26 files/182, surface claims 34,
    recurring-work 236 debt 0 (no new producer), loc catalog red ONLY on foreign terminalPreview keys.
  - FOUND BY THE REAL APP: hydration refills ptyIdsByTabId + tab.ptyId with the remembered id, so a
    store-only "bound" check left the one row that had to be marked; restore now reads the host's
    listSessions() at click time. Unit fixture had encoded the same wrong assumption.
  - FOUND BY UNIT: e2e wake-reading parsed an unset var as 0 bytes (Number('') === 0) -> fixed.
  - Owners reused: decideTerminalTabMount + dormancy marker (new reason layout-restore), activation
    wake:false, requestDormantTerminalTabOpen, resumeSleepingAgentSessionsForWorktree (+onlyPaneKeys),
    decideDispatchAdmission/observeDispatchHostResources. No new scheduler.
  - PENDING at write time: Windows run of restore-no-wake (local build of 1bb84fff0 done); real-app
    drills M2/M3/M4/M8 on GEX44 (/home/kobii/rc-mut, log /home/kobii/rc-drill.log); unit drills;
    uncommitted test resume-sleeping-agent-session-only-pane-keys.test.ts; vault/UKDL; memory.
  - UNMEASURED: per-session wake memory cost (needs a real provider run; Owner Q1 asked for it).
- NEXT: P5 multi-window Park & Exit + blue D1 control; restore/resume across windows.
- FINDINGS: workspace activation (`activateAndRevealWorktree` / `...FolderWorkspace`,
  lib/worktree-activation.ts:119,195) calls `resumeSleepingAgentSessionsForWorktree` — "Abrir" wakes
  sleeping agents, so P4 "Restore layout only" needs a no-wake activation option. Greeting name producer =
  `orcaProfileAuthStatus.cloud.displayName` (cloud-linked only; else no name). No "last close time"
  producer exists — omit it until Park records one.

## 6. Start
`Set-Location C:\Users\User\Apps\orca-continuity-wt`; prove `git worktree list` and HEAD; read the spec.
