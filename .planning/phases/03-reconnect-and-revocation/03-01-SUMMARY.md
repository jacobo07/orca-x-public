---
phase: 03-reconnect-and-revocation
plan: 01
status: complete
completed: 2026-10-26
key-files:
  created:
    - src/main/runtime/runtime-rpc-mobile-reconnect-revocation.test.ts
---

# Plan 03-01 Summary

Plan (inline, single task): prove reconnect identity and revocation at `terminal.send` on the real RPC
server over the encrypted mobile WebSocket, then drill mutants.

- Reconnect: phone lists the terminal, closes its socket, re-authenticates as the same device; the
  handle and ptyId are identical, spawn ran once, kill never ran, and the pre-disconnect handle still
  writes to the same PTY.
- Control: an authorized phone `terminal.send` is written.
- Revocation: with the live-connection kill forced to miss, the revoked phone's next `terminal.send`
  answers `unauthorized` with `data.reason = device_revoked`, and nothing is written.
- No product code changed.

## Mutation drills (job tmp mutate-p3.ps1, 2026-10-26 16:36-16:40)
| Mutant | Result | Failing test |
|---|---|---|
| M4 revoked token treated as authorized | CAUGHT, RESTORE_VERIFIED | revoked send |
| M5 revoked reason collapsed to unknown_token | CAUGHT, RESTORE_VERIFIED | revoked send |
| M6 disconnect clears the runtime handle map | SURVIVED (equivalent): handles are retained per PTY incarnation and re-issued identically, so identity is unchanged | none, by design |
| M6b disconnect invalidates every PTY's handles | CAUGHT, RESTORE_VERIFIED | reconnect identity (also incidentally the revoke test) |
| M7 disconnect kills the PTYs | CAUGHT, RESTORE_VERIFIED | reconnect identity (kill called) |

## Gates
vitest 3/3; oxlint 0; oxfmt clean. tsc not run on the laptop (RAM law).
