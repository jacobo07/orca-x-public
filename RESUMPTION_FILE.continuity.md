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
- IN PROGRESS P3c: `src/renderer/src/components/resume-center/` — presenter written
  (`resume-center-presentation.ts`, tone type `ContinuityTone`). Still to write: `resume-center-model.ts`
  (+test), `use-desk-continuity.ts`, `use-pane-preview.ts`, `ClaimValue.tsx`, `PanePreviewThumb.tsx`,
  `ResumeCenterTabRow.tsx`, `ResumeCenterWorkspaceSection.tsx`, `ResumeCenterSummaryPanel.tsx`,
  `ResumeCenterPage.tsx`; keys `resumeCenter.*` in en/es/ja/ko/zh; register presenter + claims in
  `config/workspace-surface-claims.jsonc` (+ surface root); new blue token in main.css (both themes +
  @theme inline) for the D1 control. Then P3b plumbing: TopLevelView `resumeCenter` (+ top-level-view.ts
  lookup), `openResumeCenter` in store/slices/ui.ts, lazy route in app-shell/AppWorkspaceShell.tsx, entry
  button in ConversationsPage header, breadcrumb back.
- FINDINGS: workspace activation (`activateAndRevealWorktree` / `...FolderWorkspace`,
  lib/worktree-activation.ts:119,195) calls `resumeSleepingAgentSessionsForWorktree` — "Abrir" wakes
  sleeping agents, so P4 "Restore layout only" needs a no-wake activation option. Greeting name producer =
  `orcaProfileAuthStatus.cloud.displayName` (cloud-linked only; else no name). No "last close time"
  producer exists — omit it until Park records one.

## 6. Start
`Set-Location C:\Users\User\Apps\orca-continuity-wt`; prove `git worktree list` and HEAD; read the spec.
