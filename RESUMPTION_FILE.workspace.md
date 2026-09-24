# RESUMPTION — Orca X Workspace program (worktree `C:\Users\User\Apps\orca-cogws-ui-wt`)

## 1. Identity
Branch `orca-x/cogws-product-surface`, unpushed. Thesis: the agent surface is Orca's canonical
**Workspace** (rail entry directly below Explorer); Studio is a connected project app; the phone
gets a real upstream conversation service. Plan: `.planning/ROADMAP.md` (8 GSD phases, git-excluded).
State: `.planning/STATE.md`. This branch's `RESUMPTION_FILE.md` is the cogws program's — never edit.

## 2. State (2026-09-24)
- Phase 1 SEALED `9290c26c9..1c7d2478f`: Studio pixels proven headful (region = Studio sign-in);
  degraded/unreachable from real https servers. Cause of the old stale capture = timing (drills A/B).
- Phase 2 SEALED `8168895f0..d4dadc8cd`: Workspace below Explorer, launcher "Terminals", Vault tab
  "Sessions", Chats+Agents entries and AgentsPage removed, `activeView:'agents'` → conversations.
  GEX44: tsc 0/0/0; 10/10 E2E headless + pixels headful; 6/6 mutations caught.
- Phase 3 SEALED `8e9d5d7b5..22b478d53`: `pnpm check:workspace-surface-claims` (lint + pr.yml, AGENTS.md)
  over `config/workspace-surface-claims.jsonc`: claim rows classified to producers, status colours only
  via presenter tone maps, no model/host literals. 10/10 drills caught (G5 needed a per-floor test).
- Pre-existing red (not ours): git-status-refresh* (11), window-shortcut-policy (1).
- Long run: v2 marker for session 2aad6d8e armed 10:20 (before the Ralph-mission default landed);
  NO_CROSSINGS so far. Do not arm a Ralph mission on top — two writers.
- Concurrent owners: `orca-x/agent-federation` (missions/providers/review/approval/GEX44 model) and
  `orca-x/cognitive-workspace` (remote turns; its completeness gate is a PROGRAM matrix, not a
  surface-producer check — Phase 3 needs its own owner, not that file).

## 3. Active decisions
- Heavy verification on GEX44 only: scratchpad `gex-verify.ps1 -Base d6d839339 -Commands ...`,
  `gex-e2e2.ps1 -Headless ... -Headful ...`, `gex-status.sh`, `p2-drills.sh` (drill template).
- Format only explicit files (oxfmt); never disable max-lines — split by responsibility.
- Never name a PowerShell function with a one-letter alias (`R` = Invoke-History wiped 3 files).

## 4. Next 3 actions
1. Phase 4 (ULTRA-PLAN, internal + oneshot-architect-auditor): capability-gated host RPC for
   conversations over the pairing transport; read docs/reference/remote-wire-compatibility.md and the
   mobile-aperture gate first; both version directions fail closed.
2. Phase 5: mobile screens from src/shared/cognitive-workspace-projection.ts; add them to the gate's surfaces.
3. Keep federation's P6 surface slot agreement in mind (they own missions/review rows).

## 5. Start
Open Claude Code IN this worktree. Prove `git worktree list` and HEAD. Read `.planning/STATE.md`.
Tests: `node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts <paths>` on GEX44.
