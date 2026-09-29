# RESUMPTION — Mission Brief (Orca X)

**Identity.** Worktree `C:\Users\User\Apps\orca-mission-brief-wt`, branch `orca-x/mission-brief` from main `49b1415e7`. Owner approved the plan 2026-09-29 with defaults (GSD + Ralph as producers; Continue = resume the workspace's existing agent via Resume Center admission). Spec: `docs/reference/mission-brief.md`. Thesis: the brief is a projection of GSD `.planning` (planning inspect / roadmap analyze / smart-entry), STATE.md (quoted), git HEAD and Ralph records — it stores nothing.

**Sealed (committed, tested):**
- `4a021e001` spec · `d3332f12c` projection (29 tests, mutation drill 6/6) · `00495c3ac` fixtures without BOM · `d10771607` main reader + IPC `missionBrief:read` + preload + web `client-unsupported` (50 tests; tc:node + tc:web clean with a positive control; oxlint + oxfmt clean).

**Written, NOT yet compiled/tested/committed-as-verified (WIP commit):**
- `src/renderer/src/components/mission-brief/`: presentation, tone map (`mission-tone-class.ts`), store `use-mission-brief.ts`, actions (`mission-brief-actions.ts`), Header/Rows/Actions/FullPathDialog/Panel.
- `stateFile` added to `MissionReadings`/`MissionBrief` (reader + projection updated; tests not re-run since).

- Action 1 DONE (2026-09-29, session b2567fc8): tc:web + tc:node exit 0 (tc:web coverage of `components/mission-brief` proven by a seeded TS2322), oxlint clean (seeded-control proven), oxfmt applied to 8 files, 4 test files 50/50. UI still NOT wired or rendered. Run tools via `node_modules\.bin\*.cmd` / `node node_modules\vitest\vitest.mjs` under `cmd /c` — npx dies and RTK breaks `pnpm run` in PowerShell.

- Action 2 DONE: surface + `MissionTone` presenter + 11 claims registered (`check:workspace-surface-claims` 46 sites / 7 tone maps green); `check:status-semantics` green (it reads 2 consumers only — it does NOT judge `mission-tone-class.ts`). en.json: 86 `missionBrief.*` keys added by a scoped script; NOT `--fix`, which would also sweep 162 keys main is already missing (agents/workspace/activity-rail — base debt, not ours). es/ja/ko/zh deliberately NOT added: the catalog script states feature PRs own English and targets fall back until a localization PR.

- Action 3 CODE DONE, NOT yet seen in the real app: workspace name is a select button (`resume-center-workspace-select`, aria-pressed; click again deselects); selection keyed host+key and looked up in UNFILTERED rows; aside `resume-center-aside` shows the compact brief ABOVE the Desk Summary (kept, not replaced — no summary capability lost); `MissionBriefDialog` (`mission-brief-dialog`, sm:max-w-[1180px]) for the full brief; cached row signal chip `resume-center-workspace-mission-signal` (claimed, 47 sites). `mission-brief-actions.test.ts` 11 tests; 2 mutations (live-run-first, folder guard) each red on its own test, source restored by hash. tc:web, oxlint, oxfmt, claims, max-lines ratchet green (ratchet needs `C:\Program Files\Git\cmd` on PATH).

**Next actions:**
4. Real-app Product Reality (Brand 001 `_wt-b001-exec`, `orca-backlog-wt` ub, `gsd-long-smoke`, a repo without .planning), screenshot vs `Downloads\Imagen de ChatGPT 29 sept 2026, 20_11_45.png`, mutations, knowledge/UKDL.

**Decisions:** unlocks = phases the frontier makes reachable (last unproven dep, no external); proven only on verification `passed`; GSD percents never read; `blockers: []` from GSD is not "none"; remote hosts refused.

**Start:** `Set-Location C:\Users\User\Apps\orca-mission-brief-wt`; `git log --oneline -6`; then action 1.
