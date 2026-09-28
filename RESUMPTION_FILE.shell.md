# RESUMPTION â€” W-S: Workspace shell and reality

## 1. Identity
Worktree `C:\Users\User\Apps\orca-cogws-shell-wt`, branch `orca-x/cogws-shell-reality`, base
integration `a3445471e`, unpushed. Spec: `docs/orca-cognitive-workspace-spec.md` Â§12 (approved by
the Owner 2026-09-28). Plan + audit: session scratchpad `cw-shell-reality-plan.md`,
`cw-plan-audit-gaps.md` (15 gaps, all folded). Thesis: Workspace owns its shell, leads back out,
and shows the real estate (projects, running sessions) with Orca's own controls.

## 2. State (sealed commits)
- `698416f4a` spec Â§12 Â· `44a382c39` C3 shell (worktree sidebar unmounted, panel suppressed)
- `252ac60fe` C4 Back (`previousViewBeforeConversations`, `closeConversationsPage`, WorkspaceExitButton)
- `e7bcd8949` C1 color-scheme on :root/.dark; iframes pinned normal
- `2b8707714` C2 AgentProjectPicker (Popover+Command, one row per Project, host labels from
  `useSidebarHostScopeOptions`), 5 e2e sites via `tests/e2e/helpers/new-agent-project-picker.ts`
- `751d3407d` host choice carries repoId · `a98b934a3` C7 Projects tab = canonical estate
  (WorkspaceProjectsSection, per-host Open via openProjectInWorkbench)
- `7d29cd800` C5/C6 Running in terminals (useLiveDashboardSnapshot → projectRunningSessions;
  host-offline from registry health; presenter registered; no merge, spec 12.2(3))
Coherence anchor: `git log --oneline a3445471e..HEAD` shows 8 commits, last `7d29cd800`.
OWED: real-Electron e2e + screenshots (GEX44 headless; Windows for the native popup), full tsc,
oxfmt on LF, knowledge/UKDL/CBR, final report.

## 3. Active decisions
- Side panel SUPPRESSED on 'conversations' (closing it already unmounts panel content; closed =
  zero-width rail included). Rail relocates only for a leading side strip, hence Back.
- Agent record forbids session binding (agent-types.ts:8): no "attach" control (C8 omitted).
- Formatter check only on GEX44: this Windows checkout is CRLF, oxfmt fails untouched files too.
- Local vitest per file is fine (â‰ˆ1â€“40 s); `tsc -p config/tsconfig.tc.web.json` locally 68 s.

## 4. Next 3 actions
1. C7: new `WorkspaceProjectsSection.tsx` over `useAgentProjectChoices()` + agent rows; per-host
   "Open" via `openProjectInWorkbench(host.repoId)` showing its outcome; "New agent here". Replace
   ProjectsSection in CognitiveWorkspaceRoster.tsx (file at ~305 lines; keep â‰¤400).
2. C5/C6: `workspace-running-sessions.ts` over `useLiveDashboardSnapshot()`; optional
   `providerSessionId` on DashboardCard (remote-wire doc); host-offline from registry health.
3. GEX44 batch: full tsc, oxfmt --check, affected vitest, e2e (shell, Back, picker, sessions).

## 5. Start
Open Claude Code IN this worktree. Prove `git worktree list` + HEAD. Read Â§12 and this file.
