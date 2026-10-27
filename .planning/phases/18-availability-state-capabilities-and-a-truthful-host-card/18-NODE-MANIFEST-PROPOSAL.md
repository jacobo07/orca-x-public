# Node Manifest: host capabilities (proposal, D-06)

Owner of the change: **DWS lane** (`C:\ox`). This lane wrote nothing in `C:\ox`; this is a proposal only.

## What exists today (read, not changed)

- `C:\ox\src\shared\node-manifest.ts:29`: `node.capabilities: string[] | null`, documented at line 28 as
  "`null` = the host did not say, which is not 'has none'".
- `C:\ox\src\shared\node-manifest.ts:222`: `manifestOf` fills it from `member.facts.capabilities`.
- `C:\ox\src\shared\fleet-resource-observation.ts:72-82`: `fleetHostFactsFromStatus(status, runtimeId)` sets those
  facts from the host's `status.get` result: `capabilities` is kept when it is an array of strings (sorted), else `null`.
- `C:\ox\src\shared\node-manifest.ts:31-32`: `known_heads?: string[]`, "Absent means unknown; an empty list is never
  emitted" — the rule this proposal reuses.

So the presence string `host.availability.v1` (18-01, `src/shared/protocol-version.ts:150` here) **already reaches**
`node.capabilities` with no `C:\ox` change, as soon as a host running this lane's status.get answers the fleet
reader. What does not reach it is the per-capability value, its reason and its evidence.

## Proposed additive field

```ts
node: {
  // ...existing fields unchanged
  /** Absent means unknown (same rule as known_heads). Source: status.get `hostAvailability`. */
  host_capabilities?: {
    observed_at: number
    values: Record<HostCapabilityId, { value: HostCapabilityValue; reason: string }>
  }
}
```

- `HostCapabilityId` / `HostCapabilityValue` are the vocabularies in `src/shared/host-availability.ts`
  (`can-start-orca`, `can-wake-lan`, `can-wake-remote`, `can-power-on-oob`, `can-relay`, `can-direct`;
  `supported`, `not-supported`, `not-configured`, `needs-owner-setup`, `unknown`).
- Source: `parseHostAvailabilityAnnouncement(statusResult)` over the same `status.get` result
  `fleetHostFactsFromStatus` already reads. It is total: an old host, a malformed entry or a missing evidence object
  degrade to `unknown` with a reason, so the manifest never invents a value.
- `observed_at` is the observer's clock (as `node-manifest.ts:233` requires for every `measured_at`), never the
  host-supplied `observedAt`.
- Evidence stays at the phone. The manifest carries value + reason only; the phone card is the surface that must
  show evidence (D-10), and a placement decision needs the value, not the proof object.
- Absent when the host did not announce `host.availability.v1` or the announcement was unreadable. Never emitted as
  an empty object.

## Why not flatten into `capabilities[]`

Strings like `can-wake-lan:not-configured` would (a) lose the reason, which is what tells the Owner what to fix,
and (b) be matched by prefix by old readers. `fleet-placement.ts:145-151` checks `capabilities` by exact membership
for placement; a flattened `can-relay:supported` string would be a new capability name to them, and a reader that
starts matching `can-relay` by prefix would read `can-relay:unknown` as present. The capability list stays a set of
protocol capability names.

## Compatibility (remote-wire-compatibility.md Rule 1)

- Optional field, additive. An old manifest reader ignores it; a new reader treats its absence as unknown.
- No new stream opcode, no change to an existing field's meaning, `NODE_MANIFEST_SCHEMA` stays
  `orca.node-manifest/1`.
- Mixed versions: an old host gives no `hostAvailability` → field absent → unknown, which is the truth.

## Proof of no write to C:\ox

Captured before the first edit of 18-03 and again after the mutant drills, with
`git -C C:\ox status --porcelain` and `git -C C:\ox rev-parse HEAD`, then compared with `cmp`.

Before (HEAD): `2b9ec2709afadc29ec4bd6a2e2975ce7b9adfa75`
After (HEAD): `2b9ec2709afadc29ec4bd6a2e2975ce7b9adfa75`

Before (porcelain), identical bytes after (sha256 prefix `5aa26d1404881539` for both):

```
 M src/renderer/src/components/settings/ReplicaTopologyDetails.test.tsx
 M src/renderer/src/components/settings/replica-topology-presentation.ts
 M src/renderer/src/i18n/locales/en.json
 M src/renderer/src/i18n/locales/es.json
```

Those four modifications belong to another session in `C:\ox`; this lane neither made nor touched them.
`cmp` printed `PORCELAIN IDENTICAL` and `HEAD IDENTICAL`.
