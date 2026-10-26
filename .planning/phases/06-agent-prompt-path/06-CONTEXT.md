# Phase 6: Agent prompt path - Context

**Gathered:** 2026-10-26
**Status:** Ready for planning
**Mode:** Autonomous smart-discuss (unattended; recommended option taken)

<domain>
## Phase Boundary
A phone's Agent turn is admitted by the canonical conversation owner and runs in the Agent's own
project on this host; the request cannot pick the directory or the host. The live provider leg is
PASS with evidence or EXTERNAL_BLOCKED with the exact reason.
</domain>

<decisions>
## Implementation Decisions
- D-01 Canonical owner: `conversations.sendTurn` (src/main/runtime/rpc/methods/conversations.ts) ->
  `createConversationHost().sendTurn` (forces `cwd: null`) -> the one ConversationService and turn
  runner (conversation-turn-runner.ts:156, project path wins) -> `resolveAgentProjectLocation`
  (agent-project-location.ts: own project only, local setups only, remote refused).
- D-02 Defense in depth means an outer-layer mutant is masked by inner layers, so drills target the
  innermost owners (turn runner and location resolver) where nothing can mask them.
- D-03 Live provider leg is EXTERNAL_BLOCKED: a real turn spends provider quota and may need an
  interactive login, both Owner-only in STATE. Not attempted.
</decisions>
