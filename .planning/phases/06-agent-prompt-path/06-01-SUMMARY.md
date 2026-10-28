---
phase: 06-agent-prompt-path
plan: 01
status: complete
completed: 2026-10-26
key-files:
  created: []
---

# Plan 06-01 Summary

No code changed: the owner already exists and is layered (06-CONTEXT D-01). This phase measured it.

- Ownership suites on the laptop: 4 files, 19/19 (agent-turn-runs-in-its-project,
  conversation-host, agent-project-isolation, rpc/methods/conversations).

| Mutant (job tmp mutate-p6.ps1, 16:54) | Result | Failing assertions |
|---|---|---|
| P6-M1 caller cwd wins over the project path (turn runner :156) | CAUGHT, RESTORE_VERIFIED | Project A agent stays in A while focused on B; overrides the caller's directory |
| P6-M2 any project's setup accepted | CAUGHT, RESTORE_VERIFIED | two agents two directories; follows binding change |
| P6-M3 remote setup treated as local | CAUGHT, RESTORE_VERIFIED | refuses rather than running somewhere else |

- Live provider leg: EXTERNAL_BLOCKED. Exact reason: a real provider turn spends quota and may need an
  interactive login; both are Owner-only (STATE "Owner-only"). Provider-independent layers are proven
  above. To lift: Owner authorizes one real turn from the paired phone (or the headless client) to a
  project Agent, then the run is recorded with its turn id and the cwd the provider reported.
- Mobile caller: mobile/src/workspace/mobile-workspace-client.test.ts already asserts "sends the turn
  with no cwd"; not re-run in this phase (mobile deps live on GEX44).
