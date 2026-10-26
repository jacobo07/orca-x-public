---
phase: 04-host-and-runtime-selector-truth
plan: 01
status: complete
completed: 2026-10-26
key-files:
  created:
    - mobile/src/worktree/host-switch-row-isolation.test.ts
---

# Plan 04-01 Summary

- New sequence test proves the A->B switch on one reused home screen: only B rows shown and cached,
  A's late answer dropped and never cached, A saw exactly one read (`worktree.ps`) and nothing after.
  A no-switch control admits the same A answer.
- No product code changed; the producers already exist (04-CONTEXT D-01).

## Run (GEX44, root /tmp/orca-phone-p4-20261026T154506Z, HEAD 8e6e78c7b + this test, node v24.21.0, pnpm 10.24.0)
- `pnpm install --frozen-lockfile --ignore-scripts` exit 0.
- Baseline: 5 files (host-switch-row-isolation, worktree-catalog-snapshot-client, MobileSessionHostPicker,
  mobile-session-host-options, worktree-cache), 34/34 passed.

| Mutant | Result | Failing tests (assertions) |
|---|---|---|
| P4-M1 picker auto-connects every listed host | CAUGHT, RESTORE_VERIFIED | MobileSessionHostPicker: observes without connecting; tracks no host while closed |
| P4-M2 catalog admits a superseded host's answer | CAUGHT, RESTORE_VERIFIED | host-switch-row-isolation; catalog "drops a superseded host response" |
| P4-M3 never-connected labelled Disconnected | CAUGHT, RESTORE_VERIFIED | host-options "not connected, not a failure"; picker state rows |

Teardown: 0 processes in the root before removal; root absent after.
Local gates: oxfmt clean, oxlint (mobile config) clean. tsc not run.
