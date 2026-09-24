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
- Phase 3 IN PROGRESS — relay `agentProcess.*` (`364e85cfe`), ssh spawn adapter + shared wire + rung-2
  real-process integration (`8dbe0dada`), runner async remote seam + `resolveSshCodexDriver` +
  host-scoped provenance (`d2e961591`), gate separator fix (`6e58c4fd8`). GEX44 fenced: green.
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

1. Phase 3 (d): mutation drill (see STATE.md list) with `config/scripts/mutation-transaction.mjs`.
2. Phase 3 (e): rung 3 on GEX44 — isolated remote user, real `codex app-server` via the relay handler,
   `/proc/<pid>/cwd` == setup path, zero processes after; then 03-VERIFICATION, flip matrix rows.
3. Phase 4 per `.planning/phases/04-provider-resume-relocation/04-CONTEXT.md`.

## 5. Start

Read `.planning/STATE.md` §Position, prove the worktree, run the anchors, continue at §4.
Heavy suites → GEX44 via `scratchpad/gex44-verify.ps1` (session scratchpad; recreate from STATE if gone).
