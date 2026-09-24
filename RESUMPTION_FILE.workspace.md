# RESUMPTION — Orca X Workspace program (worktree `C:\Users\User\Apps\orca-cogws-ui-wt`)

## 1. Identity
Branch `orca-x/cogws-product-surface`, CW-UI-1 = `cfd621873..4df61c6ca` (16 commits, unpushed).
Thesis: the Cognitive Workspace surface becomes Orca's canonical **Workspace** rail entry; Studio is
a connected project app; the phone gets a real upstream conversation service. Plan of record:
`.planning/ROADMAP.md` (8 GSD phases, git-excluded, worktree-local). This branch's
`RESUMPTION_FILE.md` belongs to the cogws program — never edit it.

## 2. State (measured 2026-09-24)
- CW-UI-1 proven: 6/6 real-Electron specs on GEX44 at `d6d839339`; 7/7 mutations caught.
- Open defect: Studio window capture showed the chat frame, not Studio (Phase 1).
- Concurrent owners — do NOT duplicate:
  - `Apps\orca-federation-wt` / `orca-x/agent-federation` (live, dirty): delegation to durable
    agents via orchestration.db, providers, routing, review, approval, GEX44 local model. It forked
    from this branch at `591ab8986` and lacks the 11 later commits (all the Studio work).
  - `Apps\orca-cogws-wt` / `orca-x/cognitive-workspace` (live long run): remote turns; owns
    `check:cognitive-workspace-completeness`, which Phase 3 extends.
- Owner decisions 2026-09-24: new surface takes rail label/slot "Workspace"; current terminal view
  relabelled (route ids `workspace`/`conversations`/`agents` unchanged, persisted activeView must
  still resolve); Chats + Agents merge in, then leave. No ÁGORA/Hermes/Kados/KEOS registration.
- Coherence anchor: `git log --format=%s -1 4df61c6ca` = "docs(workspace): what the surface shows,
  what it refuses to show, and why".

## 3. Active decisions
- Rail order owner: `src/renderer/src/components/activity-rail/workspace-activity-items.ts`
  (its test pins order). Labels: `WorkspaceActivityRailSection.tsx`.
- Heavy verification only on GEX44 (bundle → fetch → pin sha → xvfb); local host ~2.7 GB free.
- Format only explicit files with oxfmt; never a directory.
- Mutation drills report PLANT/CAUGHT/SURVIVED/HARNESS_FAILED + RESTORE_VERIFIED.

## 4. Next 3 actions
1. Phase 1: bind the Studio capture to a proven-painted guest frame; drive degraded/unreachable.
2. Phase 2: inventory Chats/Agents/terminal-Workspace entry actions, then relabel + merge.
3. Phase 3: extend the completeness gate with a synthetic red drill.

## 5. Start
Open Claude Code IN `C:\Users\User\Apps\orca-cogws-ui-wt` in its own Cursor window. Prove
`git worktree list` and HEAD. Arm `/cpp-gsd-long` (preflight must print `(True, 'ok')`; mission
terms are in `.planning/STATE.md`). Tests: `node node_modules/vitest/vitest.mjs run --config
config/vitest.config.ts <paths>` — never the full suite locally.
