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
- `95eff10ee` `1f14bb1be` `512895400` shell spec fixes found by its first real runs
- `d9ed840ad` dark-mode leg: root `color-scheme: dark` + list paints dark (luminance < 0.3)
Coherence anchor: `git log --oneline a3445471e..HEAD` shows 16 commits, the last updating this
file; last spec `d9ed840ad`.
VERIFIED on GEX44 (`/home/kobii/cw-shell-wt`, node 24): tsc node/cli/web clean incl. uncached
(`--composite false --incremental false`) and a planted-error control goes red; oxfmt --check
clean; 8 affected vitest files 45/45; real-Electron `workspace-shell-reality.spec.ts` PASS at
`d9ed840ad` (run5); screenshots read. `connected-application-studio` + `agent-federation-approval` PASS.
VERIFIED on Windows (this host, real Electron, es locale): every body step of the shell spec
passed incl. dark picker (trace: only error is `dispose()` EPERM rmdir of the temp profile —
transient lock, dir deleted fine afterwards; pre-existing helper `orca-restart.ts:85`).
NOT A BRANCH DEFECT: `agent-chat-project-location` + `cognitive-workspace-surface` get
`no-provider` (want `auth-required`) on GEX44 — identical on base `a3445471e` (A/B run2).

## 3. Active decisions
- Side panel SUPPRESSED on 'conversations' (closing it already unmounts panel content; closed =
  zero-width rail included). Rail relocates only for a leading side strip, hence Back.
- Agent record forbids session binding (agent-types.ts:8): no "attach" control (C8 omitted).
- Formatter check only on GEX44: this Windows checkout is CRLF, oxfmt fails untouched files too.
- Local vitest per file is fine (â‰ˆ1â€“40 s); `tsc -p config/tsconfig.tc.web.json` locally 68 s.

## 4. Next 3 actions
1. W-S is verified; the Owner decides push/merge. Nothing else is owed on this branch.
2. Separate debt: why GEX44 reports `no-provider` with claude/codex in /usr/local/bin.
3. Separate debt: `orca-restart.ts` dispose retries give up before Windows releases the profile.
GEX44 run dirs: cw-shell-e2e-run{,2,3,4,5}; base A/B worktree `/home/kobii/cw-shell-base`.

## 5. Start
Open Claude Code IN this worktree. Prove `git worktree list` + HEAD. Read Â§12 and this file.
