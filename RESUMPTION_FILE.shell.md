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
- `3c0fafc38` e2e `workspace-shell-reality.spec.ts` · `d966b3e30` oxfmt (made on GEX44 LF, ff'd back)
Coherence anchor: `git log --oneline a3445471e..HEAD` shows 11 commits, last `d966b3e30`.
VERIFIED on GEX44 (`/home/kobii/cw-shell-wt`, node 24): tsc node/cli/web clean incl. uncached
(`--composite false --incremental false`); oxfmt --check clean; 8 affected vitest files 45/45.
OWED: e2e result (`/home/kobii/cw-shell-e2e-run/`), Windows native popup, knowledge/UKDL, report.

## 3. Active decisions
- Side panel SUPPRESSED on 'conversations' (closing it already unmounts panel content; closed =
  zero-width rail included). Rail relocates only for a leading side strip, hence Back.
- Agent record forbids session binding (agent-types.ts:8): no "attach" control (C8 omitted).
- Formatter check only on GEX44: this Windows checkout is CRLF, oxfmt fails untouched files too.
- Local vitest per file is fine (â‰ˆ1â€“40 s); `tsc -p config/tsconfig.tc.web.json` locally 68 s.

## 4. Next 3 actions
1. Read the GEX44 e2e verdict: `cat /home/kobii/cw-shell-e2e-run/exit` + `run.log`; scp the PNGs
   back and look at them. Fix any red before anything else.
2. Windows: the picker is a Radix popover, so confirm it opens in the real app on this host.
3. Distil the lessons, write the final report; branch stays unpushed until the Owner says so.

## 5. Start
Open Claude Code IN this worktree. Prove `git worktree list` + HEAD. Read Â§12 and this file.
