---
phase: 03-reconnect-and-revocation
status: passed
verified: 2026-10-26
score: 2/2
---

# Phase 3 Verification

| # | Success criterion | Evidence | Result |
|---|---|---|---|
| 1 | Session ids before and after reconnect are equal and the PTY count did not grow | reconnect test: [handle, ptyId] equal, spawn x1, kill x0; M6b and M7 CAUGHT | PASS |
| 2 | A revoked device's next mutation is refused with a distinct code | revoked test: `unauthorized` + `data.reason=device_revoked`, zero writes; authorized control written; M4 and M5 CAUGHT | PASS |

Plane: local integration (real RPC server, real encrypted WebSocket on 127.0.0.1, fake PTY controller).
Not device, not live laptop app; those legs are Phase 7.
