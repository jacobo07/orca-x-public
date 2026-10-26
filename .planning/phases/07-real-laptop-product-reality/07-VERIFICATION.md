---
phase: 07-real-laptop-product-reality
status: human_needed
verified: 2026-10-26
score: 1/2
human_verification:
  - "Physical phone (or the Android 14 emulator, labelled): pair to the running Orca X, type a marker-nonce command in the bottom composer, see the line, reconnect, revoke in Settings. The scripted leg below proves the host side; it does not exercise the phone UI."
---

# Phase 7 Verification

| # | Success criterion | Evidence | Result |
|---|---|---|---|
| 1 | Paired client, laptop PTY, nonce, fresh output, reconnect and revocation all observed live | SCRIPTED CLIENT on the Owner's installed Windows Orca X, 2026-10-26 18:13-18:19 (below) | MET for the host side (SCRIPTED CLIENT); phone UI not exercised |
| 2 | Emulator evidence is labelled emulator | No emulator or phone evidence yet; the scripted leg is labelled SCRIPTED CLIENT | NOT MET (nothing to label) |

## Live Windows leg (SCRIPTED CLIENT, Owner decision (a))

Plane: `C:\Users\Jacobo\AppData\Local\Programs\orca\Orca X.exe`, running, paired from its own Mobile screen ("Copy pairing code"). Client: `src/main/runtime/mobile-live-windows-leg.live.test.ts` speaking the phone's E2EE protocol (`tests/e2e/helpers/mobile-protocol-client.ts`). Not a phone, not an emulator.

Phone leg (`ORCA_LIVE_LEG=phone`, 279 s, passed):
- `repo.list` from the paired device returned the Owner's 3 projects; a dedicated terminal was created in `C:/Users/Jacobo/Desktop/Cursor Projects/Orca X` (handle `term_e9fdb0e1-…`, ptyId `99e39e04-…@@bcc0fc09`). The Owner's existing terminals were never written to.
- Send with nonce → oracle FRESH (output after the pre-send cursor, typed text cannot match).
- Socket closed and re-authenticated with the same device token → `terminal.list` handle and ptyId pairs identical; second nonce FRESH.
- A handle the host never minted → refused.
- Owner revoked the device in Settings while the socket stayed open → `terminal.read` and `terminal.send` both got NO reply within 10 s; re-authentication with the revoked token was rejected.

Witness leg (`ORCA_LIVE_LEG=witness`, second pairing, 2.5 s, passed):
- Same handle shows the same ptyId from a second client.
- Output after cursor 7 (taken just before the revoked send) does not contain `ORCA-LIVE-389c45c8 nonce-d5c102b4` → ABSENT; the witness's own nonce is FRESH on the same read path (positive control).
- The dedicated terminal was closed by the witness.

## Findings
- RETRACTED (same day): "revocation is silent" was an artifact of the scripted client, whose `call()` never settles when its socket closes. Code reading: revoke terminates the device's sockets (`ws.terminate()`, so the phone sees 1006) and every later request gets a typed `unauthorized` / `device_revoked` (device-authorization.ts). The real defect was one layer up: the reconnect handshake refused a revoked token with a plain `unauthorized`, which the phone retries 3 times as maybe-transient (#5200). Fixed in 6fac32885 + 1175cda5d (handshake names `reason: device_revoked`; the phone latches at once). The live run's "NO_REPLY" lines should read "socket terminated".
- The bundled CLI shim `resources\bin\orca.exe` fails on this install: "Unable to locate Orca.exe next to …resources" (the executable is `Orca X.exe`).
- `repo.list` returns mixed path separators (one `C:\…`, two `C:/…`); a client matching on a native Windows path misses a registered project.
