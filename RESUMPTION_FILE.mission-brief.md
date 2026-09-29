# RESUMPTION — Mission Brief (Orca X)

**Identity.** Worktree `C:\Users\User\Apps\orca-mission-brief-wt`, branch `orca-x/mission-brief` from main `49b1415e7`. Owner approved the plan 2026-09-29 with defaults (GSD + Ralph as producers; Continue = resume the workspace's existing agent via Resume Center admission). Spec: `docs/reference/mission-brief.md`. Thesis: the brief is a projection of GSD `.planning` (planning inspect / roadmap analyze / smart-entry), STATE.md (quoted), git HEAD and Ralph records — it stores nothing.

**Sealed (committed, tested):**
- `4a021e001` spec · `d3332f12c` projection (29 tests, mutation drill 6/6) · `00495c3ac` fixtures without BOM · `d10771607` main reader + IPC `missionBrief:read` + preload + web `client-unsupported` (50 tests; tc:node + tc:web clean with a positive control; oxlint + oxfmt clean).

**Written, NOT yet compiled/tested/committed-as-verified (WIP commit):**
- `src/renderer/src/components/mission-brief/`: presentation, tone map (`mission-tone-class.ts`), store `use-mission-brief.ts`, actions (`mission-brief-actions.ts`), Header/Rows/Actions/FullPathDialog/Panel.
- `stateFile` added to `MissionReadings`/`MissionBrief` (reader + projection updated; tests not re-run since).

**Next 3 actions:**
1. Run tc:web, oxlint/oxfmt on `components/mission-brief`, and the 4 mission-brief test files; fix.
2. Register the claims: add `src/renderer/src/components/mission-brief` to `surfaces` and a `MissionTone` presenter (module `mission-brief-presentation.ts`) in `config/workspace-surface-claims.jsonc`; classify testIds `mission-brief-{signal-label,objective,frontier,last-verified,next-action,unlocks,intervention,delegable,blockers,freshness,path-stage-state}` (signal-label absent = "omitted"); run `pnpm check:workspace-surface-claims` + `check:status-semantics`. Then `verify-localization-catalog --fix` for en, and add es/ja/ko/zh `missionBrief.*`.
3. Resume Center integration: row selection in `ResumeCenterPage` → aside shows `<MissionBriefPanel variant="compact">` instead of the Desk Summary; "Open full brief" → Dialog (max-w ~1180px) with `variant="full"`; row signal via `useCachedMissionSignal` in `ResumeCenterWorkspaceSection`. Then unit tests for `planContinue`/`planNeedsMe`, real-app Product Reality (Brand 001 `_wt-b001-exec`, `orca-backlog-wt` ub, `gsd-long-smoke`, a repo without .planning), screenshot vs `Downloads\Imagen de ChatGPT 29 sept 2026, 20_11_45.png`, mutations, knowledge/UKDL.

**Decisions:** unlocks = phases the frontier makes reachable (last unproven dep, no external); proven only on verification `passed`; GSD percents never read; `blockers: []` from GSD is not "none"; remote hosts refused.

**Start:** `Set-Location C:\Users\User\Apps\orca-mission-brief-wt`; `git log --oneline -6`; then action 1.
