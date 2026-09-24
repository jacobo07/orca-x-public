# RESUMPTION — Orca Cognitive Workspace, long run (remote-project-agent / provider-resume)

## 1. Identity

Worktree **`C:\Users\User\Apps\orca-cogws-wt`**, branch **`orca-x/cognitive-workspace`** (unpushed).
A `/clear`'d pane has SIX times opened the Desktop checkout instead — prove `git worktree list` first.
Long run: session `a83285fc`, `/gsd-autonomous`, 12 cycles / 24 h, roadmap `.planning/ROADMAP.md`
(git-excluded), state `.planning/STATE.md` (authoritative position — read it first).
Spec of record: `docs/orca-cognitive-workspace-spec.md`. Done-gate:
`node config/scripts/check-cognitive-workspace-completeness.mjs` (exit 1 today = open rows; expected).

## 2. Exact state (2026-09-24)

- Phase 1 COMPLETE — completeness verifier + matrix `config/cognitive-workspace-completeness.jsonc`,
  integrity step in pr.yml, drill 2/2 (`778e8f800`..`723b14b99`).
- Phase 2 COMPLETE — `resolved-remote` / `ambiguous-host` location model, selection by rule
  (`b63595026`..`59f636afe`, drill 5/5).
- Phase 3 COMPLETE (`364e85cfe`..`0e8e0fb64`) — relay `agentProcess.*`, ssh spawn adapter, runner
  remote seam, `provider-unavailable` states. GEX44: drill 11/11, control 83/83, tsc 0; opt-in rung 3
  (`ORCA_REAL_CODEX_RUNG=1`) runs the installed codex through the real relay handler. Matrix C/G/I
  stay open: the real ssh channel is Phase 5, and the model turn is quota-blocked.
- Phase 4 COMPLETE (`66d26bde3`..`36c723e1d`) — a resumed thread relocates to the project's new
  directory only on a Codex whose `initialize` version (≥ 0.153.4) is measured to do it, and only if
  it confirms the directory; otherwise a new thread in the right place. Drill 19/19. Matrix E done.
- Coherence anchors (all must pass): check-durable-actor-catalogs, check-agent-identity-authority,
  check-recurring-work-inventory, check-agent-instruction-layer, check-agent-turn-location-authority,
  check-cognitive-workspace-completeness --integrity.

## 3. Active decisions

- Conversation stays on the desktop; only the provider EFFECT runs on the ssh host (headless serve has
  no ConversationService). Runtime hosts refuse (`remote-host`).
- Relay output rides the bulk lane, sequenced; a gap is an error, never a hole. Remote child `pid`
  undefined; desktop env never shipped (overlay: CODEX_HOME only).
- Codex `thread/resume` DOES accept `cwd` (schema 0.153.4 + 0.155.1; protocol-observed on GEX44) —
  Phase 4 sends it version-gated; cross-host move = new thread, same ConversationId.
- Real provider behaviour legs: GEX44 Codex quota-blocked until 2026-09-27 19:54; local homes signed out.

## 4. Next three actions

1. Phase 5: the real-ssh product rung (desktop mux over a real ssh channel to GEX44's relay).
2. Phases 6–9 per `.planning/ROADMAP.md`.
3. After 2026-09-27 19:54: the model-turn legs (matrix I, Phase 4 behaviour rung, audit gaps 11/14).

## 5. Start

Read `.planning/STATE.md` §Position, prove the worktree, run the anchors, continue at §4.
Heavy suites → GEX44 via `scratchpad/gex44-verify.ps1` (session scratchpad; recreate from STATE if gone).
