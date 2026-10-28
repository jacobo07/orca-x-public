---
covers: [D2, device-registry, token-hashing]
status: DONE 2026-10-19 (Owner chose the policy and approved the plan 2026-10-18)
---

# D2: hash paired device tokens at rest

Threat model T2/D2 (`docs/dws/threat-model-2026-10-18.md`): `<userData>/orca-devices.json` holds every
paired device's live bearer token in plain text. Anyone who reads the file can act as any paired phone
or runtime client.

## Decision (Owner, 2026-10-18)

A paired device stores `tokenHash` (sha256 hex) and no `token`. The one **pending** entry (`lastSeenAt === 0`)
keeps its raw `token`, because an unscanned QR offer is re-advertised after a restart
(`getOrCreatePendingDevice`, `runtime-rpc.ts:785,793,1006`). The first sighting (`updateLastSeen` 0 -> t)
drops the raw value and keeps the hash. Rotating the pending entry already deletes it (`rotatePendingDevice`).

## Format: same file, same bare array

The durability contract `runtime.device-registry` promises a bare array "so an older build still reads it",
and `save()` writes one. No version bump. Each entry gains `tokenHash`; paired entries lose `token`.

| Reader | Sees | Result |
|---|---|---|
| this build, legacy entry with `token` only | load hashes it; pending keeps raw | migrated on the next save |
| this build, hashed entry | `validateToken` hashes the presented token, looks up by hash | auth unchanged for clients |
| older build, hashed entry | `d.token === token` never matches | that device is refused (fails closed); file stays readable; pending pairing works |

Residual, older build only: its `removeDevice` calls `hashToken(removed.token)` on an entry without `token`,
which throws after the in-memory removal and before the save, so the removal does not persist. That device
cannot authenticate on that build anyway.

## Code changes

At rest only. The raw token stays in MEMORY exactly as today once known, because live sockets are keyed by it
(`mobile-socket-wiring.ts:64,174`; revoke ends them by it, `device-authorization.ts:54`).

- `device-registry.ts`: `DeviceEntry` gets `tokenHash: string`; `token?: string` is known while pending or once
  the device authenticates this run (`validateToken` learns it, memory only). `save()` writes paired entries
  without `token`. `load` hashes legacy tokens and saves once to migrate them. `removeDevice` tombstones
  `tokenHash`.
- `runtime-rpc.ts:973`: compare `tokenHash`, not `token`.
- `device-authorization.ts:54`: terminate only when the raw token is known; unknown means the device never
  connected this run, so it has no sockets.
- `runtime-rpc.ts:793,1006`, `mobile-socket-wiring.ts:64`: unchanged; they read a pending or just-authenticated
  entry, which carries `token`. A missing token there throws, never sends `undefined`.
- `config/durability-contracts.jsonc` `runtime.device-registry.state`: say what is stored now.

No wire change: clients still send the raw token; the host only hashes it.

## Acceptance

1. Pair -> scan -> restart -> reconnect authenticates; the file holds no raw token for that device (read-back).
2. Pending QR shown -> restart -> same offer still pairs.
3. Legacy file (raw tokens, one pending) loads, authenticates every device, and the next save holds hashes only
   for paired entries.
4. Revoke -> the tombstone still refuses the old token (`isRevokedToken`).
5. Older-build simulation: a hashed entry under the old lookup is refused, not accepted.
6. Mutants red: lookup by raw token; first sighting keeps raw; legacy load skips hashing.
7. Existing `device-registry*` and runtime-rpc mobile tests green; `check:durability-contracts` green.

## Rollback

Revert the commit. A hashed registry under the reverted build behaves as row 3 of the table: paired devices
re-pair once, pending pairing works, nothing is renamed or lost.
