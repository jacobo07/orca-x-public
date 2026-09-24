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
- Phase 4 SEALED `04690f984..db465645c`: conversations.* runtime RPC (mobile-allowlisted, capability`conversations.v1`, no remote cwd), host wired for desktop + headless serve; real mobile-scope E2EE e2e
  passes; 7/7 drills. Placement proven in the real strip (`ea6ebf2d8`, fresh build).
- Phase 5 SEALED `226af0f09..a2b559900`: phone Workspace (roster + agent chat, host toolbar entry),
  proven by the phone module over real E2EE + an old-host stand-in; mobile vitest 9/9. OWED: an
  emulator/device render (no Android SDK on GEX44) and live streaming in the phone chat.
- Phase 6 SEALED `a3d358e32..b07e22188`: 200 agents / 1,000 threads on GEX44 — scale adds 59 ms, product
  open 208 ms, 12.9k DOM nodes, 61 MB heap. The ~4 s first reading was Playwright's pointer wait (a
  one-agent control proved it). No virtualization, by measurement; the budget gates the scale delta.
- Phase 7 DEPENDS_ON_FEDERATION: federation is at P4b; its surface is P6. No merge, no rows.
- Phase 8: full suite at b07e22188 vs base e677d00d8 on GEX44 — identical 392 failing tests (0 ours),
  typecheck 0/0/0, 7 gates green, mobile-aperture red on app.park (pre-existing). See 08-VERIFICATION.md.
- TERMINAL STATUS: BLOCKED_BY_OWNER_AUTHORIZATION — Studio OIDC sign-in; provider quota (to ~09-27);
  federation merge (or wait for its P6); a phone/AVD for pixels; a CI runner.
- Pre-existing red (not ours): git-status-refresh* (11), window-shortcut-policy (1), check:mobile-aperture on `app.park` (acd975a06).
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
1. When federation seals P6 (or the Owner orders it): merge `orca-x/agent-federation`, add each row's
   producer to `config/workspace-surface-claims.jsonc`, e2e: a delegated task created via the product
   API appears in Workspace (07-VERIFICATION.md).
2. After the quotas reset (~2026-09-27): one real provider turn through desktop Workspace and the phone
   module; then wire `conversations.subscribe` into the phone chat.
3. With the Owner: Studio sign-in (CONNECTED state) and a device render of the phone screens.
## 5. Start
Open Claude Code IN this worktree. Prove `git worktree list` and HEAD. Read `.planning/STATE.md`.
Tests: `node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts <paths>` on GEX44.
